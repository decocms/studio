import {
  AlertCircle,
  CheckCircle,
  Circle,
  Eye,
  Loading02,
} from "@untitledui/icons";
import type { ToolOutput } from "@/tools/io-types";

export type KanbanTask = ToolOutput<"KANBAN_TASK_LIST">["items"][number];
export type KanbanTaskStatus = KanbanTask["status"];
export type KanbanTaskPriority = KanbanTask["priority"];

/** Shape of an org member as returned by `useMembers()`, trimmed to the fields used here. */
export type Member = {
  userId: string;
  user?: { name?: string | null; image?: string | null };
};

export const STATUSES: KanbanTaskStatus[] = [
  "triage",
  "todo",
  "in_progress",
  "in_review",
  "done",
];

export const STATUS_CONFIG: Record<
  KanbanTaskStatus,
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
    iconClassName: "text-blue-500 animate-spin",
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

export const PRIORITIES: KanbanTaskPriority[] = [
  "low",
  "medium",
  "high",
  "urgent",
];

export const PRIORITY_CONFIG: Record<
  KanbanTaskPriority,
  { label: string; badgeClassName: string }
> = {
  low: {
    label: "Low",
    badgeClassName: "bg-muted text-muted-foreground",
  },
  medium: {
    label: "Medium",
    badgeClassName: "bg-blue-500/10 text-blue-600",
  },
  high: {
    label: "High",
    badgeClassName: "bg-orange-500/10 text-orange-600",
  },
  urgent: {
    label: "Urgent",
    badgeClassName: "bg-red-500/10 text-red-600",
  },
};
