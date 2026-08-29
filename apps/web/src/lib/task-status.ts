/**
 * Task status utilities.
 *
 * Status is a small colored icon inline with the title.
 * Each status has a "verb" — what this means for you as a manager.
 */

import {
  AlertCircle,
  CheckCircle,
  Circle,
  Hourglass03,
  Loading01,
  XCircle,
} from "@untitledui/icons";

export type StatusKey =
  | "requires_action"
  | "failed"
  | "expired"
  | "in_progress"
  | "completed";

export interface StatusConfig {
  label: string;
  /** What this status means for you — shown as metadata */
  verb: string;
  icon: typeof Loading01;
  iconClassName: string;
  /** Color for the verb/label text */
  labelColor: string;
}

export const STATUS_CONFIG: Record<StatusKey, StatusConfig> = {
  requires_action: {
    label: "Needs review",
    verb: "Waiting for your review",
    icon: AlertCircle,
    iconClassName: "text-warning",
    labelColor: "text-warning",
  },
  failed: {
    label: "Failed",
    verb: "Something went wrong",
    icon: XCircle,
    iconClassName: "text-destructive",
    labelColor: "text-destructive",
  },
  expired: {
    label: "Timed out",
    verb: "Stopped responding",
    icon: Hourglass03,
    iconClassName: "text-warning",
    labelColor: "text-warning",
  },
  in_progress: {
    label: "Running",
    verb: "Agent is working",
    icon: Loading01,
    iconClassName: "text-primary",
    labelColor: "text-primary",
  },
  completed: {
    label: "Done",
    verb: "Completed",
    icon: CheckCircle,
    iconClassName: "text-muted-foreground/50",
    labelColor: "text-muted-foreground",
  },
};

const UNKNOWN: StatusConfig = {
  label: "Unknown",
  verb: "Unknown status",
  icon: Circle,
  iconClassName: "text-muted-foreground",
  labelColor: "text-muted-foreground",
};

function isStatusKey(status: string): status is StatusKey {
  return status in STATUS_CONFIG;
}

export function getStatusConfig(status: string | undefined): StatusConfig {
  const key = status ?? "completed";
  return isStatusKey(key) ? STATUS_CONFIG[key] : UNKNOWN;
}
