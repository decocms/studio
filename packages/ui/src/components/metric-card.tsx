import type * as React from "react";

import { cn } from "../lib/utils.ts";

type MetricStatus = "success" | "warning" | "error";

const STATUS_DOT: Record<MetricStatus, string> = {
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
};

type MetricCardProps = Omit<React.ComponentProps<"div">, "children"> & {
  label: React.ReactNode;
  value: React.ReactNode;
  /** The goal the value is measured against. */
  caption?: React.ReactNode;
  /** How the metric is doing against its goal; shown as a dot by the label. */
  status?: MetricStatus;
  /** A trend beside the value, usually a `Sparkline`. */
  trend?: React.ReactNode;
};

/** A metric at a glance: what it is, where it stands, and against what. */
function MetricCard({
  label,
  value,
  caption,
  status,
  trend,
  className,
  ...props
}: MetricCardProps) {
  return (
    <div
      data-slot="metric-card"
      className={cn("surface flex flex-col gap-1.5 p-3", className)}
      {...props}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {label}
        </span>
        {status && (
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status])}
          />
        )}
      </div>
      <div className="flex items-end gap-2">
        <span className="font-display tnum min-w-0 flex-1 truncate text-[1.375rem] leading-tight">
          {value}
        </span>
        {trend}
      </div>
      {caption && <p className="text-subtle-foreground text-xs">{caption}</p>}
    </div>
  );
}

export { MetricCard };
export type { MetricStatus };
