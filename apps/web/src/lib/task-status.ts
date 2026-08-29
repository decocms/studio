/**
 * Task status utilities.
 *
 * Status is a small colored icon inline with the title.
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
  icon: typeof Loading01;
  iconClassName: string;
  /** Color for the label text */
  labelColor: string;
}

export const STATUS_CONFIG: Record<StatusKey, StatusConfig> = {
  requires_action: {
    label: "Needs review",
    icon: AlertCircle,
    iconClassName: "text-warning",
    labelColor: "text-warning",
  },
  failed: {
    label: "Failed",
    icon: XCircle,
    iconClassName: "text-destructive",
    labelColor: "text-destructive",
  },
  expired: {
    label: "Timed out",
    icon: Hourglass03,
    iconClassName: "text-warning",
    labelColor: "text-warning",
  },
  in_progress: {
    label: "Running",
    icon: Loading01,
    iconClassName: "text-primary",
    labelColor: "text-primary",
  },
  completed: {
    label: "Done",
    icon: CheckCircle,
    iconClassName: "text-muted-foreground/50",
    labelColor: "text-muted-foreground",
  },
};

const UNKNOWN: StatusConfig = {
  label: "Unknown",
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
