/**
 * Per-column agent automation. An org's board settings can flag a column with
 * `automation: { enabled, agentId }`; when a task ENTERS that column (a human
 * drag, an edit, a create straight into it, or a run-driven advance) the
 * configured agent is enqueued on the task — the ai-services-panel
 * "auto-execute / auto-QA on column entry" pattern.
 *
 * The `automation_column_id` stamp on the item is the re-trigger guard: the
 * agent's own run bouncing the task (QA reopens it → finishes → In Review
 * again) never re-fires the same column, while a human moving the card away
 * and back deliberately re-arms it (the update tool clears the stamp on human
 * moves). Best-effort throughout — automation must never fail the write that
 * moved the card.
 */

import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem, TaskBoardItemStatus } from "@/storage/types";
import {
  columnForItem,
  resolveBoardColumns,
  shouldTriggerColumnAutomation,
} from "@decocms/shared/task-board-columns";
import { enqueueAgentForTask } from "./enqueue-super-agent";

/**
 * React to a task landing in a (possibly new) column. `previous` is the
 * task's placement before this write (null for a create). No-op when the org
 * has no automation on the target column, the task didn't actually change
 * column, the guard stamp is set, or a linked run is active.
 */
export async function reactToColumnEntry(
  ctx: StudioContext,
  item: TaskBoardItem,
  previous: { status: TaskBoardItemStatus; columnId: string | null } | null,
): Promise<void> {
  try {
    const settings = await ctx.storage.organizationSettings.get(
      item.organizationId,
    );
    const columns = resolveBoardColumns(settings?.task_board?.columns);
    const column = columnForItem(item, columns);
    const previousColumnId = previous
      ? columnForItem(previous, columns).id
      : null;
    if (
      !shouldTriggerColumnAutomation({
        column,
        previousColumnId,
        automationColumnId: item.automationColumnId,
        threads: item.threads,
      })
    ) {
      return;
    }

    // Stamp the guard BEFORE enqueueing so a re-entrant advance (the run's
    // own lifecycle moving the card) can never double-fire this column.
    await ctx.storage.taskBoard.update(
      item.id,
      item.organizationId,
      { automationColumnId: column.id },
      item.updatedBy,
    );
    await enqueueAgentForTask(ctx, item, column.automation?.agentId ?? null);
  } catch (err) {
    console.error("[task-board] column automation failed", err);
  }
}
