import {
  AlertCircle,
  CheckCircle,
  Circle,
  Eye,
  Loading02,
} from "@untitledui/icons";
import type { ToolOutput } from "@/tools/io-types";

export { SUPER_AGENT_ASSIGNEE_ID } from "@/shared/task-board";

export type TaskBoardItem = ToolOutput<"TASK_BOARD_ITEM_LIST">["items"][number];
export type TaskBoardItemStatus = TaskBoardItem["status"];
export type TaskBoardItemPriority = TaskBoardItem["priority"];
export type TaskBoardItemThread = TaskBoardItem["threads"][number];
export type TaskBoardItemPr =
  ToolOutput<"TASK_BOARD_ITEM_PRS_GET">["prs"][number];

/**
 * A task is "blocked" when one of its agent threads is waiting on human input
 * (`requires_action` — the agent called `user_ask` or needs an approval).
 */
export function isTaskBlocked(item: TaskBoardItem): boolean {
  return item.threads.some((t) => t.status === "requires_action");
}

/** The thread to surface in the card — the most recent linked run. */
export function primaryThread(
  item: TaskBoardItem,
): TaskBoardItemThread | undefined {
  return item.threads[0];
}

/** Shape of an org member as returned by `useMembers()`, trimmed to the fields used here. */
export type Member = {
  userId: string;
  user?: { name?: string | null; image?: string | null };
};

export const STATUSES: TaskBoardItemStatus[] = [
  "triage",
  "todo",
  "in_progress",
  "in_review",
  "done",
];

export const STATUS_CONFIG: Record<
  TaskBoardItemStatus,
  { label: string; icon: typeof Circle; iconClassName: string }
> = {
  triage: {
    label: "Backlog",
    icon: AlertCircle,
    iconClassName: "text-muted-foreground",
  },
  todo: {
    label: "To Do",
    icon: Circle,
    iconClassName: "text-muted-foreground",
  },
  in_progress: {
    label: "In Progress",
    icon: Loading02,
    iconClassName: "text-blue-500",
  },
  in_review: {
    label: "In Review",
    icon: Eye,
    iconClassName: "text-warning",
  },
  done: {
    label: "Done",
    icon: CheckCircle,
    iconClassName: "text-success",
  },
};

export const PRIORITIES: TaskBoardItemPriority[] = [
  "none",
  "low",
  "medium",
  "high",
  "urgent",
];

export const PRIORITY_CONFIG: Record<
  TaskBoardItemPriority,
  {
    label: string;
    flagClassName: string;
    dotClassName: string;
  }
> = {
  none: {
    label: "No priority",
    flagClassName: "text-muted-foreground",
    dotClassName: "border border-muted-foreground/50",
  },
  low: {
    label: "Low",
    flagClassName: "text-muted-foreground",
    dotClassName: "bg-muted-foreground/40",
  },
  medium: {
    label: "Medium",
    flagClassName: "text-blue-500",
    dotClassName: "bg-blue-500",
  },
  high: {
    label: "High",
    flagClassName: "text-warning",
    dotClassName: "bg-warning",
  },
  urgent: {
    label: "Urgent",
    flagClassName: "text-destructive",
    dotClassName: "bg-destructive",
  },
};
