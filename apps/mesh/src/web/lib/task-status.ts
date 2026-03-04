/**
 * Shared task status configuration.
 *
 * Used by both the /tasks/ page and the compact TaskListContent panel.
 */

import type { Task } from "@/web/components/chat/task/types";
import {
  CheckCircle,
  Hourglass03,
  Loading01,
  Placeholder,
  XCircle,
} from "@untitledui/icons";

export const STATUS_ORDER = [
  "in_progress",
  "requires_action",
  "failed",
  "expired",
  "completed",
] as const;

export const STATUS_CONFIG: Record<
  string,
  { label: string; icon: typeof Loading01; iconClassName: string }
> = {
  in_progress: {
    label: "In Progress",
    icon: Loading01,
    iconClassName: "text-muted-foreground animate-spin",
  },
  requires_action: {
    label: "Need Action",
    icon: Placeholder,
    iconClassName: "text-orange-500",
  },
  failed: {
    label: "Failed",
    icon: XCircle,
    iconClassName: "text-destructive",
  },
  expired: {
    label: "Timed Out",
    icon: Hourglass03,
    iconClassName: "text-warning",
  },
  completed: {
    label: "Complete",
    icon: CheckCircle,
    iconClassName: "text-success",
  },
};

export function groupByStatus(tasks: Task[]) {
  const groups: Record<string, Task[]> = {};
  for (const task of tasks) {
    const status = task.status ?? "completed";
    if (!groups[status]) groups[status] = [];
    groups[status].push(task);
  }
  for (const group of Object.values(groups)) {
    group.sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
  }
  return groups;
}
