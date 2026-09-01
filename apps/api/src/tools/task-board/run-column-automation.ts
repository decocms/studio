/**
 * "When a card lands in this column, run the agent."
 *
 * The rule lives on the column (`task_board_column_automations`), so this is
 * the same act however the card arrived: the Jira pull moving it, or a person
 * dragging it. Both funnel here so a column cannot mean one thing to the sync
 * and another to the board.
 *
 * The card's OWN column is the fence, not a fixed lane. A rule on any column
 * has to claim the card sitting in that column, or a rule on anything but the
 * queue lane could never win — which is exactly what the Jira path did before
 * this was shared.
 */

import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import { boardAutomationFor } from "./board-handler";
import { reactToSuperAgentDelegation } from "./enqueue-super-agent";

export interface ColumnAutomationRun {
  /** Who the card is delegated to and attributed to. The Jira pull runs as the
   *  integration's creator; a person's drag runs as that person. */
  assignedBy: string;
  /** Actor recorded on the write. Null for the machine. */
  actor: string;
}

/**
 * Run this column's rule on `item`, or leave it alone.
 *
 * Returns the card as it stands afterwards — unchanged when the column has no
 * rule, when someone already owns the card, or when a concurrent trigger won
 * the claim. A quota rejection un-delegates rather than leaving a card
 * assigned to an agent that will never run.
 *
 * The claim is conditional rather than a plain update because several triggers
 * can be mid-flight on one card — the sync's cron, a webhook wake-up whose
 * debounce is per-pod, a person dragging it — and a read-then-write would buy
 * two agent runs.
 */
export async function runColumnAutomation(
  ctx: StudioContext,
  item: TaskBoardItem,
  by: ColumnAutomationRun,
): Promise<TaskBoardItem> {
  if (item.assigneeId) return item;
  const orgId = item.organizationId;
  const automation = await boardAutomationFor(ctx, orgId, item.status);
  if (!automation) return item;

  const delegated = await ctx.storage.taskBoard.claimUnassignedForSuperAgent(
    item.id,
    orgId,
    by.assignedBy,
    by.actor,
    item.status,
  );
  if (!delegated) return item;

  await ctx.storage.taskBoard.recordActivity({
    taskBoardItemId: item.id,
    action: "assignee_changed",
    actorId: null,
    data: { from: null, to: SUPER_AGENT_ASSIGNEE_ID },
  });
  try {
    await reactToSuperAgentDelegation(ctx, delegated, {
      instruction: automation.prompt ?? undefined,
    });
  } catch (err) {
    console.warn(
      `[task-board] column rule on ${item.status} rejected for ${item.id}, un-delegating:`,
      err instanceof Error ? err.message : err,
    );
    // Same conditional fence as `handTaskToHuman` — never stomp a concurrent reassignment.
    const undelegated = await ctx.storage.taskBoard.unassignSuperAgent(
      item.id,
      orgId,
      by.actor,
    );
    // Fence lost: a human owns the card now. Returning `delegated` would emit a
    // snapshot that reads as their reassignment reverted, so re-read the row.
    return (
      undelegated ??
      (await ctx.storage.taskBoard.getById(item.id, orgId)) ??
      delegated
    );
  }
  return delegated;
}
