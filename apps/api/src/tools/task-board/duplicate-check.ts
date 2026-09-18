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
 * - one `generateObject` call on the org's "fast" tier says whether one of them
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

import { generateObject } from "ai";
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
 * Ask the org's "fast" tier which candidate, if any, already tracks the draft.
 * Returns null when there is no provider, the call fails, or nothing was
 * offered — the caller then creates the card.
 */
async function judgeDuplicate(
  ctx: StudioContext,
  orgId: string,
  draft: TaskDraft,
  candidates: readonly TaskBoardItem[],
): Promise<DuplicateVerdict | null> {
  if (candidates.length === 0) return null;
  try {
    const tier = await resolveTier(ctx, "fast");
    const provider = await ctx.aiProviders.activate(tier.credentialId, orgId);
    const model = provider.aiSdk.languageModel(tier.modelId);
    const { object } = await generateObject({
      model,
      schema: DuplicateVerdictSchema,
      system: SYSTEM,
      prompt: buildDuplicatePrompt(draft, candidates),
      temperature: 0,
    });
    return object;
  } catch (err) {
    console.warn("[task-board] duplicate check failed, creating anyway", err);
    return null;
  }
}

/**
 * The whole check: candidates, verdict, gate. Resolves to the existing card
 * that already tracks the draft, or null when the card should be created.
 */
export async function findDuplicateTask(
  ctx: StudioContext,
  orgId: string,
  draft: TaskDraft,
): Promise<{ item: TaskBoardItem; reason: string } | null> {
  const items = await ctx.storage.taskBoard.list(orgId);
  const candidates = selectDuplicateCandidates(items, draft);
  const verdict = await judgeDuplicate(ctx, orgId, draft, candidates);
  const match = acceptDuplicate(verdict, candidates);
  return match && verdict ? { item: match, reason: verdict.reason } : null;
}
