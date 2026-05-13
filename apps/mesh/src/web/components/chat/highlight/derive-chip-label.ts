/**
 * Pure helper computing the collapsed-chip label for `TodosHighlight`.
 *
 * Splits the chip's text into `activity` (truncatable, flex-1 in the chip
 * layout) and `progress` (pinned right, shrink-0). The `icon` field drives
 * the leading status mark.
 *
 * State table — keep in sync with the design spec:
 *
 *   • all pending             → { pending,     "{n} todos",          "not started" }
 *   • one in_progress         → { in_progress, "{activeForm}",       "{done}/{total} done" }
 *   • multi in_progress       → { in_progress, "{k} in progress",    "{done}/{total} done" }
 *   • all completed           → { completed,   "All done",           "{total}/{total}" }
 *
 * Empty list is tolerated for safety but the caller short-circuits on
 * `todos.length === 0` and the chip never renders.
 */
import type { Todo } from "@/api/routes/decopilot/built-in-tools/todo-write";

export type ChipIcon = "pending" | "in_progress" | "completed";

export interface ChipLabel {
  icon: ChipIcon;
  activity: string;
  progress: string;
}

export function deriveChipLabel(todos: Todo[]): ChipLabel {
  const inProgress = todos.filter((t) => t.status === "in_progress");
  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;

  if (total > 0 && completed === total) {
    return {
      icon: "completed",
      activity: "All done",
      progress: `${total}/${total}`,
    };
  }
  const [firstInProgress] = inProgress;
  if (firstInProgress && inProgress.length === 1) {
    return {
      icon: "in_progress",
      activity: firstInProgress.activeForm,
      progress: `${completed}/${total} done`,
    };
  }
  if (inProgress.length > 1) {
    return {
      icon: "in_progress",
      activity: `${inProgress.length} in progress`,
      progress: `${completed}/${total} done`,
    };
  }
  return {
    icon: "pending",
    activity: `${total} todos`,
    progress: "not started",
  };
}
