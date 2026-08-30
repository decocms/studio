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
import type { TranslationKey } from "@/i18n/en/index.ts";

export type StatusKey =
  | "requires_action"
  | "failed"
  | "expired"
  | "in_progress"
  | "completed";

export interface StatusConfig {
  /** Translation key for the label — resolve with `t()`, this is not
   *  display-ready on its own. */
  labelKey: TranslationKey;
  icon: typeof Loading01;
  iconClassName: string;
  /** Color for the label text */
  labelColor: string;
}

export const STATUS_CONFIG: Record<StatusKey, StatusConfig> = {
  requires_action: {
    labelKey: "common.taskStatus.requiresAction",
    icon: AlertCircle,
    iconClassName: "text-warning",
    labelColor: "text-warning",
  },
  failed: {
    labelKey: "common.taskStatus.failed",
    icon: XCircle,
    iconClassName: "text-destructive",
    labelColor: "text-destructive",
  },
  expired: {
    labelKey: "common.taskStatus.expired",
    icon: Hourglass03,
    iconClassName: "text-warning",
    labelColor: "text-warning",
  },
  in_progress: {
    labelKey: "common.taskStatus.inProgress",
    icon: Loading01,
    iconClassName: "text-primary",
    labelColor: "text-primary",
  },
  completed: {
    labelKey: "common.taskStatus.completed",
    icon: CheckCircle,
    iconClassName: "text-muted-foreground/50",
    labelColor: "text-muted-foreground",
  },
};

const UNKNOWN: StatusConfig = {
  labelKey: "common.taskStatus.unknown",
  icon: Circle,
  iconClassName: "text-muted-foreground",
  labelColor: "text-muted-foreground",
};

function isStatusKey(status: string): status is StatusKey {
  return status in STATUS_CONFIG;
}

export function getStatusConfig(
  status: string | null | undefined,
): StatusConfig {
  // Explicit null (unlike undefined) means a genuinely unknown status, not "no status field yet".
  if (status === null) return UNKNOWN;
  const key = status ?? "completed";
  return isStatusKey(key) ? STATUS_CONFIG[key] : UNKNOWN;
}
