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
    label: "Triage",
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
    iconClassName: "text-amber-500",
  },
  done: {
    label: "Done",
    icon: CheckCircle,
    iconClassName: "text-green-600",
  },
};

export const PRIORITIES: TaskBoardItemPriority[] = [
  "low",
  "medium",
  "high",
  "urgent",
];

export const PRIORITY_CONFIG: Record<
  TaskBoardItemPriority,
  { label: string; badgeClassName: string; flagClassName: string }
> = {
  low: {
    label: "Low",
    badgeClassName: "bg-muted text-muted-foreground",
    flagClassName: "text-muted-foreground",
  },
  medium: {
    label: "Medium",
    badgeClassName: "bg-blue-500/10 text-blue-600",
    flagClassName: "text-blue-500",
  },
  high: {
    label: "High",
    badgeClassName: "bg-orange-500/10 text-orange-600",
    flagClassName: "text-orange-500",
  },
  urgent: {
    label: "Urgent",
    badgeClassName: "bg-red-500/10 text-red-600",
    flagClassName: "text-red-500",
  },
};
