/**
 * "Is this task already on the board?" — the semantic duplicate check behind
 * `TASK_BOARD_ITEM_CREATE`'s `onDuplicate: "return_existing"`.
 *
 * Until now that question lived only in prompts (`START_TASK_PROMPT`, the
 * `task` guide: "call TASK_BOARD_ITEM_LIST first and check"), which an agent
 * may skip, and in `pr-open-board-reaction.ts`, which only fires when a PR
 * opens. Callers that create cards directly — the decopilot built-in tool, the
 * code-agent virtual MCP, any API client — got no check at all. This module
 * moves the judgement into the create codepath itself.
 *
 * Shape, mirroring `pr-open-board-reaction.ts`:
 * - a pure, lexical pre-filter picks the candidate cards (bounded prompt cost);
 * - one JSON-answer call on the org's "fast" tier says whether one of them
 *   already tracks the drafted work;
 * - a pure gate accepts the verdict only at high confidence and only for an id
 *   that was actually offered.
 *
 * Best-effort throughout: no provider, a model error, or a malformed answer all
 * read as "no duplicate" and the card is created. The check must never be the
 * reason a task fails to exist. Two concurrent creates can both pass it; that
 * is accepted rather than locked around.
 *
 * Judgement, not embeddings: the repo has no vector store, an org's open board
 * is at most a few hundred cards, and a model reading titles is the pattern the
 * PR-open reaction already established.
 */

import { generateText } from "ai";
import { z } from "zod";
import type { StudioContext } from "@/core/studio-context";
import { resolveTier } from "@/core/resolve-tier";
import type { TaskBoardItem } from "@/storage/types";
import { LANES } from "@decocms/shared/task-board";

/** Cap on cards sent to the model. Same bound as the PR-open reaction. */
export const MAX_DUPLICATE_CANDIDATES = 50;

/** How much of a card's description the model sees. Titles carry most of the
 *  signal; the first lines of a description disambiguate look-alike titles. */
const DESCRIPTION_EXCERPT_CHARS = 240;

/** The drafted task, as far as the check cares. */
export interface TaskDraft {
  title: string;
  description?: string | null;
  repo?: string | null;
}

/**
 * A card in a lane where a duplicate would matter. `done`/`archived` cards are
 * excluded on purpose: filing again the work of a finished card is a legitimate
 * "do it again", not a duplicate.
 */
export function isOpenForDuplicateCheck(item: TaskBoardItem): boolean {
  return item.status !== "done" && item.status !== LANES.archive;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "is",
  "it",
  "be",
  "as",
  "at",
  "by",
  "or",
  "from",
  "that",
  "this",
  "when",
  "não",
  "nao",
  "de",
  "da",
  "do",
  "das",
  "dos",
  "em",
  "no",
  "na",
  "um",
  "uma",
  "para",
  "pra",
  "com",
  "que",
  "e",
  "o",
  "os",
  "as",
]);

/** Lowercased, de-accented, stop-word-free tokens of 3+ characters. */
export function tokenize(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const tokens = new Set<string>();
  for (const raw of normalized.split(/[^a-z0-9_]+/)) {
    if (raw.length < 3 || STOP_WORDS.has(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
}

/** Jaccard overlap between two token sets; 0 when either is empty. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * The open cards worth asking the model about, best lexical match first.
 *
 * A pre-filter, not a verdict: it only bounds what goes into the prompt. Every
 * open card is a candidate; when there are more than the cap, the ones sharing
 * the most words with the draft win, ties broken by recency. A card without a
 * repo stays in even when the draft names one (it may be the same work filed
 * org-wide); a card naming a DIFFERENT repo is out.
 */
export function selectDuplicateCandidates(
  items: readonly TaskBoardItem[],
  draft: TaskDraft,
  max: number = MAX_DUPLICATE_CANDIDATES,
): TaskBoardItem[] {
  const draftTokens = tokenize(`${draft.title} ${draft.description ?? ""}`);
  const draftRepo = draft.repo?.trim().toLowerCase() || null;

  return items
    .filter(isOpenForDuplicateCheck)
    .filter(
      (item) =>
        !draftRepo || !item.repo || item.repo.toLowerCase() === draftRepo,
    )
    .map((item) => ({
      item,
      score: overlap(
        draftTokens,
        tokenize(`${item.title} ${item.description ?? ""}`),
      ),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        Date.parse(b.item.createdAt) - Date.parse(a.item.createdAt),
    )
    .slice(0, max)
    .map(({ item }) => item);
}

export type DuplicateConfidence = "high" | "medium" | "low";

export interface DuplicateVerdict {
  /** Id of the card that already tracks this work; null when none does. */
  duplicateOf: string | null;
  confidence: DuplicateConfidence;
  /** One sentence for the caller: why this is (or isn't) the same work. */
  reason: string;
}

const DuplicateVerdictSchema = z.object({
  duplicateOf: z
    .string()
    .nullable()
    .describe(
      "Id of the existing card that already tracks the drafted work, or null when no card does.",
    ),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe(
      "`high` only when the two clearly ask for the same change. Related or overlapping work is `medium` at most.",
    ),
  reason: z
    .string()
    .describe("One sentence explaining the match, or the absence of one."),
});

/**
 * The verdict, gated. A duplicate is only honored at `high` confidence — a
 * false positive silently swallows a real task, a false negative costs one
 * extra card, so the check leans toward creating — and only when the id names
 * one of the cards that were offered, so the model cannot point at a card
 * from another org or invent one.
 */
export function acceptDuplicate(
  verdict: DuplicateVerdict | null,
  candidates: readonly TaskBoardItem[],
): TaskBoardItem | null {
  if (!verdict?.duplicateOf || verdict.confidence !== "high") return null;
  return candidates.find((c) => c.id === verdict.duplicateOf) ?? null;
}

const SYSTEM = `You maintain a team's task board. Someone is about to file a new task. Decide whether one of the existing open cards ALREADY tracks the same work.

- Two tasks are the same work when completing one would make the other unnecessary. Match on intent, not wording: different phrasing, language, or level of detail can still be the same task.
- Related is NOT the same: a task on a neighbouring feature, a sub-part of a larger card, or the same area with a different change is not a duplicate. When in doubt, it is not a duplicate.
- Answer \`confidence: "high"\` only when you would be comfortable telling the filer "this already exists, here it is" without checking further.

Respond with ONLY a JSON object of this shape, and nothing else:
{"duplicateOf": string | null, "confidence": "high" | "medium" | "low", "reason": string}`;

function excerpt(text: string | null): string {
  if (!text) return "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > DESCRIPTION_EXCERPT_CHARS
    ? `${oneLine.slice(0, DESCRIPTION_EXCERPT_CHARS)}…`
    : oneLine;
}

/** The user turn: the draft, then every candidate as `[id] (lane, repo) title — description`. */
export function buildDuplicatePrompt(
  draft: TaskDraft,
  candidates: readonly TaskBoardItem[],
): string {
  const cardList = candidates
    .map((c) => {
      const meta = [c.status, c.repo].filter(Boolean).join(", ");
      const desc = excerpt(c.description);
      return `- [${c.id}] (${meta}) ${c.title}${desc ? ` — ${desc}` : ""}`;
    })
    .join("\n");
  const draftDesc = excerpt(draft.description ?? null);
  return `New task being filed:
Title: ${draft.title}
Repo: ${draft.repo ?? "(none)"}
Description: ${draftDesc || "(none)"}

Existing open cards:
${cardList}`;
}

/**
 * The JSON object a model was asked for, out of whatever it actually wrote:
 * bare, fenced, or wrapped in a sentence. Null when nothing parses or the
 * shape is wrong. Exported for its tests.
 */
export function parseModelJson<T>(
  text: string,
  schema: z.ZodType<T>,
): T | null {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .trim();
  for (const candidate of balancedObjects(cleaned)) {
    try {
      const parsed = schema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON at this brace; try the next object.
    }
  }
  return null;
}

/** Every top-level `{…}` span in `text`, last first: a reasoning model tends to
 *  narrate, sometimes with braces, before writing the answer it was asked for. */
function balancedObjects(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) spans.push(text.slice(start, i + 1));
    }
  }
  return spans.reverse();
}

/**
 * One JSON-answer call to the org's "fast" tier. Plain `generateText` with the
 * schema described in the prompt, not `generateObject`: the fast slot is
 * whatever cheap model the org's provider offers, and native structured-output
 * mode is not something every one of them supports through every gateway.
 *
 * Resolves to the parsed answer, or to a `skipped` reason when there is no
 * provider, the call fails, or the answer does not parse — every caller reads
 * that as "no duplicate" and creates.
 */
async function askFastTier<T>(
  ctx: StudioContext,
  orgId: string,
  schema: z.ZodType<T>,
  system: string,
  prompt: string,
): Promise<{ answer: T } | { skipped: string }> {
  try {
    const tier = await resolveTier(ctx, "fast");
    const provider = await ctx.aiProviders.activate(tier.credentialId, orgId);
    const model = provider.aiSdk.languageModel(tier.modelId);
    const { text, finishReason } = await generateText({
      model,
      system,
      prompt,
      temperature: 0,
      // Room for a reasoning model to think before the JSON it was asked for.
      maxOutputTokens: 8000,
    });
    const answer = parseModelJson(text, schema);
    if (!answer) {
      console.warn("[task-board] duplicate check: unparseable answer", {
        modelId: tier.modelId,
        finishReason,
        chars: text.length,
        tail: text.slice(-200),
      });
      return {
        skipped: `unparseable answer from ${tier.modelId} (finish=${finishReason}, chars=${text.length})`,
      };
    }
    return { answer };
  } catch (err) {
    console.warn("[task-board] duplicate check failed, creating anyway", err);
    return { skipped: err instanceof Error ? err.message : String(err) };
  }
}

/** What the check concluded, for the caller and for whoever reads the tool's
 *  output: a match, a clean miss, or a check that could not run. */
export type DuplicateOutcome =
  | { status: "matched"; item: TaskBoardItem; reason: string }
  | { status: "no_match" }
  | { status: "skipped"; reason: string };

/**
 * Batch form, for the reports import, which lands up to 100 findings at once.
 * One model call for the whole batch, never one per item: the import holds a
 * transaction open while it writes, and this check runs before it.
 *
 * A draft in a batch, addressed by its position so the verdict can name it.
 */
export interface IndexedDraft extends TaskDraft {
  index: number;
}

/** Candidates offered per draft before the union is taken. Small on purpose:
 *  a batch of 100 drafts × 10 each is already a long prompt. */
const BATCH_CANDIDATES_PER_DRAFT = 10;
/** Cap on the union of candidates a batch call may carry. */
const MAX_BATCH_CANDIDATES = 100;

/**
 * The union of each draft's best lexical matches, order preserved by first
 * appearance, capped. Every draft contributes its top few so a large batch
 * cannot crowd out one draft's only plausible duplicate.
 */
export function selectBatchCandidates(
  items: readonly TaskBoardItem[],
  drafts: readonly IndexedDraft[],
  perDraft: number = BATCH_CANDIDATES_PER_DRAFT,
  max: number = MAX_BATCH_CANDIDATES,
): TaskBoardItem[] {
  const seen = new Set<string>();
  const union: TaskBoardItem[] = [];
  for (const draft of drafts) {
    for (const item of selectDuplicateCandidates(items, draft, perDraft)) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      union.push(item);
      if (union.length >= max) return union;
    }
  }
  return union;
}

export interface BatchDuplicateVerdict {
  matches: {
    /** The draft's `index`. */
    draft: number;
    duplicateOf: string | null;
    confidence: DuplicateConfidence;
    reason: string;
  }[];
}

const BatchDuplicateVerdictSchema = z.object({
  matches: z
    .array(
      z.object({
        draft: z.number().int().describe("The draft's index, as listed."),
        duplicateOf: z
          .string()
          .nullable()
          .describe(
            "Id of the existing card that already tracks this draft, or null.",
          ),
        confidence: z
          .enum(["high", "medium", "low"])
          .describe(
            "`high` only when the two clearly ask for the same change. Related or overlapping work is `medium` at most.",
          ),
        reason: z.string().describe("One sentence explaining the match."),
      }),
    )
    .describe(
      "One entry per draft that has a plausible duplicate. Drafts with no candidate may be omitted.",
    ),
});

const BATCH_SYSTEM = `You maintain a team's task board. A batch of new tasks is about to be filed. For EACH draft, decide whether one of the existing open cards ALREADY tracks the same work.

- Two tasks are the same work when completing one would make the other unnecessary. Match on intent, not wording: different phrasing, language, or level of detail can still be the same task.
- Related is NOT the same: a task on a neighbouring feature, a sub-part of a larger card, or the same area with a different change is not a duplicate. When in doubt, it is not a duplicate.
- Answer \`confidence: "high"\` only when you would be comfortable telling the filer "this already exists, here it is" without checking further.
- Judge drafts against the EXISTING cards only, never against each other.

Respond with ONLY a JSON object of this shape, and nothing else:
{"matches": [{"draft": number, "duplicateOf": string | null, "confidence": "high" | "medium" | "low", "reason": string}]}`;

/** The user turn: every draft by index, then every candidate card. */
export function buildBatchDuplicatePrompt(
  drafts: readonly IndexedDraft[],
  candidates: readonly TaskBoardItem[],
): string {
  const draftList = drafts
    .map((d) => {
      const desc = excerpt(d.description ?? null);
      const repo = d.repo ? ` (${d.repo})` : "";
      return `- draft ${d.index}${repo}: ${d.title}${desc ? ` — ${desc}` : ""}`;
    })
    .join("\n");
  const cardList = candidates
    .map((c) => {
      const meta = [c.status, c.repo].filter(Boolean).join(", ");
      const desc = excerpt(c.description);
      return `- [${c.id}] (${meta}) ${c.title}${desc ? ` — ${desc}` : ""}`;
    })
    .join("\n");
  return `New tasks being filed:
${draftList}

Existing open cards:
${cardList}`;
}

/**
 * The batch verdict, gated per draft with the same rule as
 * {@link acceptDuplicate}: high confidence, an offered card id, and a draft
 * index that exists. Later entries for the same draft do not override an
 * earlier accepted one.
 */
export function acceptBatchDuplicates(
  verdict: BatchDuplicateVerdict | null,
  drafts: readonly IndexedDraft[],
  candidates: readonly TaskBoardItem[],
): Map<number, { item: TaskBoardItem; reason: string }> {
  const accepted = new Map<number, { item: TaskBoardItem; reason: string }>();
  if (!verdict) return accepted;
  const known = new Set(drafts.map((d) => d.index));
  for (const m of verdict.matches) {
    if (!known.has(m.draft) || accepted.has(m.draft)) continue;
    const item = acceptDuplicate(
      {
        duplicateOf: m.duplicateOf,
        confidence: m.confidence,
        reason: m.reason,
      },
      candidates,
    );
    if (item) accepted.set(m.draft, { item, reason: m.reason });
  }
  return accepted;
}

/**
 * The batch check: for each draft, the existing card that already tracks it.
 * Drafts absent from the result should be created. One model call for the
 * whole batch; an empty draft list or no candidates costs nothing.
 */
export async function findDuplicatesForBatch(
  ctx: StudioContext,
  orgId: string,
  drafts: readonly IndexedDraft[],
): Promise<Map<number, { item: TaskBoardItem; reason: string }>> {
  if (drafts.length === 0) return new Map();
  const items = await ctx.storage.taskBoard.list(orgId);
  const candidates = selectBatchCandidates(items, drafts);
  if (candidates.length === 0) return new Map();
  const asked = await askFastTier(
    ctx,
    orgId,
    BatchDuplicateVerdictSchema,
    BATCH_SYSTEM,
    buildBatchDuplicatePrompt(drafts, candidates),
  );
  if ("skipped" in asked) return new Map();
  return acceptBatchDuplicates(asked.answer, drafts, candidates);
}

/**
 * The whole check: candidates, verdict, gate. `matched` carries the existing
 * card; `no_match` and `skipped` both mean "create", but the caller tells them
 * apart so a check that never ran is not mistaken for a clean miss.
 */
export async function findDuplicateTask(
  ctx: StudioContext,
  orgId: string,
  draft: TaskDraft,
): Promise<DuplicateOutcome> {
  const items = await ctx.storage.taskBoard.list(orgId);
  const candidates = selectDuplicateCandidates(items, draft);
  if (candidates.length === 0) return { status: "no_match" };
  const asked = await askFastTier(
    ctx,
    orgId,
    DuplicateVerdictSchema,
    SYSTEM,
    buildDuplicatePrompt(draft, candidates),
  );
  if ("skipped" in asked) return { status: "skipped", reason: asked.skipped };
  const match = acceptDuplicate(asked.answer, candidates);
  return match
    ? { status: "matched", item: match, reason: asked.answer.reason }
    : { status: "no_match" };
}
