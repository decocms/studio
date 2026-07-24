/**
 * Task board column resolution — pure helpers shared by the server tools and
 * the web board.
 *
 * Columns are per-org config (`organization_settings.task_board.columns`);
 * each maps onto one of the canonical 5 stages so run-driven automation
 * (todo → in_progress → in_review) keeps working over custom columns. A task
 * stores its stage in `status` and, when placed in a custom column, that
 * column's id in `columnId`. Null config = the default simple board.
 */

import type { TaskBoardColumnConfig } from "./organization/schema";
import type { TaskBoardItemStatus } from "./entities";

/**
 * The canonical stage ladder — the full delivery lifecycle, in order. External
 * trackers (Jira, Linear, …) map their statuses INTO these via a per-connection
 * de/para, so the vocabulary must be rich enough to hold distinct positions
 * like Code Review, QA and Deploy. `status` is a plain text column (no DB
 * enum), so this list is the single source of truth and grows without a
 * migration. The 3 tail stages (qa, ready_for_release, deploy) have no default
 * column — they surface only when a user adds a column or a sync maps into them.
 */
export const TASK_BOARD_STAGES: TaskBoardItemStatus[] = [
  "triage",
  "todo",
  "in_progress",
  "in_review",
  "qa",
  "ready_for_release",
  "deploy",
  "done",
];

/**
 * Stages that get a lane on the DEFAULT (unconfigured) board — the original 5.
 * Deliberately a subset of the ladder: adding stages to `TASK_BOARD_STAGES`
 * must NOT change what an org sees until it customizes its columns.
 */
const DEFAULT_STAGES: TaskBoardItemStatus[] = [
  "triage",
  "todo",
  "in_progress",
  "in_review",
  "done",
];

/** The default simple board: one column per default stage, id = stage name,
 *  name = null (the UI renders its i18n label). */
export const DEFAULT_TASK_BOARD_COLUMNS: TaskBoardColumnConfig[] =
  DEFAULT_STAGES.map((stage) => ({ id: stage, name: null, stage }));

/**
 * The org's effective column set. Falls back to the defaults when the config
 * is null/empty or lost every valid column (defensive — a board must always
 * render lanes).
 */
export function resolveBoardColumns(
  columns: TaskBoardColumnConfig[] | null | undefined,
): TaskBoardColumnConfig[] {
  if (!columns || columns.length === 0) return DEFAULT_TASK_BOARD_COLUMNS;
  const valid = columns.filter((c) =>
    TASK_BOARD_STAGES.includes(c.stage as TaskBoardItemStatus),
  );
  return valid.length > 0 ? valid : DEFAULT_TASK_BOARD_COLUMNS;
}

/**
 * The column a task renders in: its explicit `columnId` when that column still
 * exists, else the first column of its stage, else the first column (a task
 * must always land somewhere — e.g. its stage's only column was deleted).
 */
export function columnForItem(
  item: { status: TaskBoardItemStatus; columnId: string | null },
  columns: TaskBoardColumnConfig[],
): TaskBoardColumnConfig {
  if (item.columnId) {
    const explicit = columns.find((c) => c.id === item.columnId);
    if (explicit) return explicit;
  }
  return columns.find((c) => c.stage === item.status) ?? columns[0]!;
}

/**
 * Should entering `column` enqueue its automation agent for this task?
 * Pure — unit-tested. Requires: automation enabled, an actual column change
 * (`previousColumnId` differs), the guard stamp not already set to this column
 * (a run-driven bounce — QA reopens → finishes → In Review again — must not
 * loop), and no linked thread still running.
 */
export function shouldTriggerColumnAutomation(params: {
  column: TaskBoardColumnConfig;
  previousColumnId: string | null;
  automationColumnId: string | null;
  threads: { status: string | null }[];
}): boolean {
  if (!params.column.automation?.enabled) return false;
  if (params.previousColumnId === params.column.id) return false;
  if (params.automationColumnId === params.column.id) return false;
  if (params.threads.some((t) => t.status === "in_progress")) return false;
  return true;
}
