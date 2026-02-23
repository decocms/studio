/**
 * Shared status badge component and config for report status indicators.
 * Used by both the reports list and report detail views.
 */

import type { ReportStatus } from "@decocms/bindings";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  AlertCircle,
  CheckCircle,
  InfoCircle,
  XCircle,
} from "@untitledui/icons";

export const STATUS_CONFIG: Record<
  ReportStatus,
  { label: string; color: string; icon: typeof CheckCircle }
> = {
  passing: {
    label: "Passing",
    color:
      "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/25",
    icon: CheckCircle,
  },
  warning: {
    label: "Warning",
    color:
      "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/25",
    icon: AlertCircle,
  },
  failing: {
    label: "Failing",
    color: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/25",
    icon: XCircle,
  },
  info: {
    label: "Info",
    color: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/25",
    icon: InfoCircle,
  },
};

export function StatusBadge({
  status,
  size = "default",
}: {
  status: ReportStatus;
  size?: "sm" | "default";
}) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG["info"];
  const Icon = cfg.icon;
  const isSmall = size === "sm";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border text-xs font-medium",
        isSmall ? "px-2 py-0.5" : "px-2.5 py-1",
        cfg.color,
      )}
    >
      <Icon size={isSmall ? 12 : 14} />
      {cfg.label}
    </span>
  );
}
