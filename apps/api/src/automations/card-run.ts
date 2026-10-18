/**
 * An automation fire that carries a card runs on that card: as the board's
 * own run (`enqueueSuperAgentForTask`), linked to the card, on its repository
 * and pull request, with the board's prompts and tools. The fire workflow
 * takes this branch for any fire with a card target; the trigger only decides
 * when and on which card.
 */

import {
  type ReviewerKind,
  SUPER_AGENT_ASSIGNEE_ID,
} from "@decocms/shared/task-board";
import type { ClaudeCodeModelClass } from "@/harnesses/claude-code-env";
import type { StudioContext } from "@/core/studio-context";
import type { Automation, TaskBoardItem } from "@/storage/types";
import {
  enqueueSuperAgentForTask,
  type SuperAgentPromptOpts,
} from "@/tools/task-board/enqueue-super-agent";
import { TaskQuotaError, type TaskQuotaReason } from "@/billing/task-quota";
import { emitTaskBoardUpdated } from "@/tools/task-board/run-reactions";
import {
  enqueueReviewerForTask,
  reviewerThreadId,
  reviewFenceKey,
} from "@/tools/task-board/reviewer-run";
import {
  automationInstruction,
  cardFireFence,
} from "./board-column-transition";
import { IMPLEMENTER_SYSTEM_KEY, REVIEWER_SYSTEM_KEY } from "./builtin";

/** A card a fire runs on: the card, the column the run is for, and the event
 *  that picked it (it keys the run, so a retried fire starts it once). */
export interface CardTarget {
  kind: "card";
  itemId: string;
  columnKey: string;
  eventKey: string;
  /** Who moved the card there; null for a machine move. */
  movedBy: string | null;
  /** Set on the built-in Reviewer's fire: which review run to start. The
   *  review sweep already decided it is due. */
  review?: {
    kind: ReviewerKind;
    /** ISO; the cycle's start, which the run's fence and token key on. */
    cycleAt: string;
    attempt: number;
    modelClass: ClaudeCodeModelClass;
  };
  /** Set when a person or the board asked for this run (Run, Re-run, a
   *  delegation, a retry, a conflict fix): it runs whatever the column gates
   *  say, with these run options, and its error goes back to the caller. */
  manual?: ManualRun;
}

/** The board-run options a manual fire carries through to the run. */
export type ManualRun = Pick<
  SuperAgentPromptOpts,
  "userInitiated" | "runClass" | "pr" | "resolveConflict"
>;

/** Why a run was refused, serializable so it survives the workflow. A quota
 *  refusal keeps its reason, so the caller can raise the paywall. */
export interface RunError {
  message: string;
  quotaReason?: TaskQuotaReason;
}

export function runErrorOf(err: unknown): RunError {
  if (err instanceof TaskQuotaError) {
    return { message: err.message, quotaReason: err.reason };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

export type CardRunSkip =
  | "card_gone"
  | "moved_on"
  | "busy"
  | "owned"
  | "delegated"
  | "lost_claim"
  | "rejected";

export type CardRunOutcome =
  | { threadId: string }
  | { skipped: CardRunSkip; error?: RunError };

/**
 * Run `automation` on the target card. It skips a card that left the column
 * since, one with a run still going (runs on a card take turns), and one a
 * person owns. An unassigned card is claimed for the agent in the same
 * conditional write that checks its column, so two fires can never both
 * start a run.
 */
/** A run is working the card: started, and not finished or abandoned. */
export function hasLiveRun(item: Pick<TaskBoardItem, "threads">): boolean {
  return item.threads.some(
    (t) =>
      t.hasMessages &&
      (t.status === "in_progress" || t.status === "requires_action"),
  );
}

export async function runAutomationOnCard(
  ctx: StudioContext,
  automation: Automation,
  triggerId: string,
  target: CardTarget,
): Promise<CardRunOutcome> {
  const item = await ctx.storage.taskBoard.getById(
    target.itemId,
    automation.organization_id,
  );
  if (!item) return { skipped: "card_gone" };
  if (automation.system_key === REVIEWER_SYSTEM_KEY && target.review) {
    return await runReviewOnCard(ctx, item, triggerId, target.review);
  }
  if (target.manual) {
    return await runManuallyOnCard(ctx, automation, item, triggerId, target);
  }
  if (item.status !== target.columnKey) return { skipped: "moved_on" };
  if (hasLiveRun(item)) return { skipped: "busy" };
  if (item.assigneeId && item.assigneeId !== SUPER_AGENT_ASSIGNEE_ID) {
    return { skipped: "owned" };
  }
  // Delegating a card moves it to In Progress and starts its run right away;
  // the implementer is for the cards nobody handed over.
  if (
    automation.system_key === IMPLEMENTER_SYSTEM_KEY &&
    item.assigneeId === SUPER_AGENT_ASSIGNEE_ID
  ) {
    return { skipped: "delegated" };
  }

  // The claim makes the run its owner's. A built-in's run belongs to whoever
  // moved the card, as delegating it would; the member standing in as its
  // creator is only the fallback.
  const owner =
    (automation.system_key && target.movedBy) || automation.created_by;
  let card = item;
  let claimed = false;
  if (!item.assigneeId) {
    const won = await ctx.storage.taskBoard.claimUnassignedForSuperAgent(
      item.id,
      item.organizationId,
      owner,
      owner,
      target.columnKey,
    );
    if (!won) return { skipped: "lost_claim" };
    card = won;
    claimed = true;
    await ctx.storage.taskBoard
      .recordActivity({
        taskBoardItemId: item.id,
        action: "assignee_changed",
        actorId: null,
        data: { from: null, to: SUPER_AGENT_ASSIGNEE_ID },
      })
      .catch(() => {});
    emitTaskBoardUpdated(item.organizationId, won);
  }

  const fence = cardFireFence(triggerId, target.eventKey);
  try {
    await enqueueSuperAgentForTask(ctx, card, {
      instruction: automationInstruction(automation.messages) || undefined,
      column: target.columnKey,
      automation: {
        name: automation.name,
        agentId: automation.virtual_mcp_id,
        triggerId,
        fence,
      },
    });
  } catch (err) {
    console.warn(
      `[automations] "${automation.name}" on card ${item.id} was not dispatched:`,
      err instanceof Error ? err.message : err,
    );
    if (claimed) {
      const released = await ctx.storage.taskBoard.unassignSuperAgent(
        item.id,
        item.organizationId,
        owner,
      );
      if (released) emitTaskBoardUpdated(item.organizationId, released);
    }
    return { skipped: "rejected", error: runErrorOf(err) };
  }
  return { threadId: fence.threadId };
}

/** A run someone asked for on a card the caller already put in place: the
 *  card is the agent's and in its column, so no gate or claim applies. */
async function runManuallyOnCard(
  ctx: StudioContext,
  automation: Automation,
  item: TaskBoardItem,
  triggerId: string,
  target: CardTarget,
): Promise<CardRunOutcome> {
  const fence = cardFireFence(triggerId, target.eventKey);
  try {
    await enqueueSuperAgentForTask(ctx, item, {
      ...target.manual,
      instruction: automationInstruction(automation.messages) || undefined,
      column: target.columnKey,
      automation: {
        name: automation.name,
        agentId: automation.virtual_mcp_id,
        triggerId,
        fence,
      },
    });
  } catch (err) {
    return { skipped: "rejected", error: runErrorOf(err) };
  }
  return { threadId: fence.threadId };
}

/** The Reviewer's run: the card stays the Super Agent's, the review runs as a
 *  linked thread. None of the column gates apply; the sweep that fired it
 *  checked the review is due. */
async function runReviewOnCard(
  ctx: StudioContext,
  item: TaskBoardItem,
  triggerId: string,
  review: NonNullable<CardTarget["review"]>,
): Promise<CardRunOutcome> {
  const cycleAt = new Date(review.cycleAt);
  const queued = await enqueueReviewerForTask(
    ctx,
    item,
    review.kind,
    cycleAt,
    review.attempt,
    review.modelClass,
    triggerId,
  ).catch((err) => {
    console.warn(
      `[automations] ${review.kind} on card ${item.id} was not dispatched:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  });
  if (queued === null) return { skipped: "rejected" };
  // A concurrent fire already started this attempt's run.
  if (!queued) return { skipped: "busy" };
  return {
    threadId: reviewerThreadId(
      reviewFenceKey(item.id, review.kind, cycleAt, review.attempt),
    ),
  };
}
