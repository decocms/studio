/**
 * Ad-hoc code agent opened a PR — put it on the board for review.
 *
 * A task-dispatched run (Super Agent) already has a linked card, and
 * `advanceTaskBoardForRun` + `capturePrForRun` move/link it. A plain chat with
 * a GitHub-imported agent has no card, so nothing happens. This reaction fills
 * that gap: one focused LLM call decides whether the work is already tracked,
 * then the action runs in code (create/update the card, link the PR + thread).
 *
 * Kept as code (not a system-prompt instruction the main loop may skip) so the
 * bookkeeping is deterministic; kept as a single LLM call (not a heuristic) so
 * the "is there already a card for this?" judgement stays with the model. The
 * whole thing is best-effort: it never throws into the run that opened the PR.
 */

import { generateObject } from "ai";
import { z } from "zod";
import type { StudioContext } from "@/core/studio-context";
import { resolveTier } from "@/core/resolve-tier";
import type { TaskBoardStorage } from "@/storage/task-board";
import type { TaskBoardItem, TaskBoardItemStatus } from "@/storage/types";
import { extractPrFromValue, type ExtractedPr } from "./pr-extract";
import { resolveRunTaskTargets, emitTaskBoardUpdated } from "./run-reactions";

/** Statuses from which a PR-open advance may move a card into review. Terminal
 *  lanes (and in_review itself) are left alone so a re-opened PR never regresses
 *  a finished card. */
const ADVANCEABLE: ReadonlySet<TaskBoardItemStatus> = new Set([
  "triage",
  "todo",
  "in_progress",
]);

export interface BoardDecision {
  action: "create" | "update";
  /** The existing card to update. Required for `update`, ignored for `create`. */
  taskId?: string | null;
  /** Short title for a new card. Used for `create`; a fallback covers absence. */
  title?: string | null;
  /** Optional note for the reviewer, posted as a comment on the card. */
  comment?: string | null;
}

const BoardDecisionSchema = z.object({
  action: z
    .enum(["create", "update"])
    .describe(
      "`update` when an existing card already tracks this work, else `create`.",
    ),
  taskId: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Id of the existing card to update. Required when action=update.",
    ),
  title: z
    .string()
    .nullable()
    .optional()
    .describe("Short title for the new card. Used when action=create."),
  comment: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Optional short note for the reviewer (a decision made, an open question). Omit if there is nothing useful to add.",
    ),
});

const SYSTEM = `You maintain a team's task board. A coding agent just opened a pull request inside a chat. Decide how the board should reflect it.

- If one of the existing cards already tracks this work, choose \`update\` and return its \`taskId\` — do NOT create a duplicate. Match on the intent of the work, not exact wording.
- If no existing card covers it, choose \`create\` and return a short \`title\` describing the change.
- Optionally add a one-line \`comment\` for the reviewer. Leave it empty when there is nothing worth saying.

Be conservative about creating: when a plausible card already exists, prefer \`update\`.`;

/**
 * Ask the org's cheap "fast" tier whether this PR maps to an existing card.
 * Best-effort: returns null when there is no model provider or the call fails,
 * so the caller falls back to doing nothing rather than guessing.
 */
async function decideBoardActionForPr(
  ctx: StudioContext,
  orgId: string,
  openCards: TaskBoardItem[],
  threadTitle: string | null,
  pr: ExtractedPr,
): Promise<BoardDecision | null> {
  try {
    const tier = await resolveTier(ctx, "fast");
    const provider = await ctx.aiProviders.activate(tier.credentialId, orgId);
    const model = provider.aiSdk.languageModel(tier.modelId);

    const cardList = openCards.length
      ? openCards.map((t) => `- [${t.id}] (${t.status}) ${t.title}`).join("\n")
      : "(none)";
    const prompt = `Work summary (chat title): ${threadTitle ?? "(untitled)"}
Pull request: ${pr.url} (${pr.owner}/${pr.repo}#${pr.number})

Existing open cards:
${cardList}`;

    const { object } = await generateObject({
      model,
      schema: BoardDecisionSchema,
      system: SYSTEM,
      prompt,
      temperature: 0,
    });
    return object;
  } catch (err) {
    console.warn("[task-board] PR-open board decision failed", err);
    return null;
  }
}

/**
 * Carry out a {@link BoardDecision}: create or update the card, link the PR and
 * the thread, and post the optional reviewer note. Pure of any LLM call so it
 * can be exercised against real Postgres. Returns the affected card, or null
 * when nothing could be done (e.g. an `update` whose taskId isn't this org's).
 */
export async function applyBoardDecision(
  storage: TaskBoardStorage,
  params: {
    orgId: string;
    userId: string;
    threadId: string;
    pr: ExtractedPr;
    decision: BoardDecision;
    /** The card set the decision was made against (this org's), for taskId validation. */
    openCards: TaskBoardItem[];
  },
): Promise<TaskBoardItem | null> {
  const { orgId, userId, threadId, pr, decision, openCards } = params;

  const linkPr = (taskBoardItemId: string) =>
    storage.linkPr({
      taskBoardItemId,
      organizationId: orgId,
      url: pr.url,
      prNumber: pr.number,
      repoOwner: pr.owner,
      repoName: pr.repo,
      connectionId: null,
    });

  const target =
    decision.action === "update" && decision.taskId
      ? openCards.find((t) => t.id === decision.taskId)
      : undefined;

  let item: TaskBoardItem | null;
  if (target) {
    // Advance into review only from an earlier lane; never regress a finished card.
    const status = ADVANCEABLE.has(target.status) ? "in_review" : undefined;
    item = await storage.update(target.id, orgId, { status }, userId);
  } else {
    // create (also the fallback when an `update` pointed at an unknown card)
    item = await storage.create({
      organizationId: orgId,
      title: decision.title?.trim() || `PR #${pr.number}`,
      status: "in_review",
      by: userId,
    });
  }
  if (!item) return null;

  await linkPr(item.id);
  await storage.linkThread(item.id, threadId, orgId);
  if (decision.comment?.trim()) {
    await storage.createComment({
      taskBoardItemId: item.id,
      organizationId: orgId,
      authorId: userId,
      body: decision.comment.trim(),
    });
  }

  const fresh = await storage.getById(item.id, orgId);
  const result = fresh ?? item;
  emitTaskBoardUpdated(orgId, result);
  return result;
}

/**
 * Entry point wired into the PR-open MCP hook. No-op for a run that already has
 * a linked card (the Super Agent path) or when there's no org/user/thread/PR.
 * Fire-and-forget; failures are logged, never thrown.
 */
export async function reactToPrOpenedForBoard(
  ctx: StudioContext,
  source: unknown,
  threadId?: string,
): Promise<void> {
  const orgId = ctx.organization?.id;
  const userId = ctx.auth?.user?.id;
  if (!orgId || !userId || !threadId) return;
  try {
    const alreadyLinked = await resolveRunTaskTargets(ctx, orgId, threadId);
    if (alreadyLinked.length > 0) return;

    const pr = extractPrFromValue(source);
    if (!pr) return;

    const cards = await ctx.storage.taskBoard.list(orgId);
    const openCards = cards.filter(
      (t) => t.status !== "done" && t.status !== "archived",
    );
    const thread = await ctx.storage.threads.get(threadId);

    const decision = await decideBoardActionForPr(
      ctx,
      orgId,
      openCards,
      thread?.title ?? null,
      pr,
    );
    if (!decision) return;

    await applyBoardDecision(ctx.storage.taskBoard, {
      orgId,
      userId,
      threadId,
      pr,
      decision,
      openCards,
    });
  } catch (err) {
    console.error("[task-board] PR-open board reaction failed", err);
  }
}
