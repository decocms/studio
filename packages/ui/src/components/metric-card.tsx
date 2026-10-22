import type * as React from "react";

import { cn } from "../lib/utils.ts";
import { Card } from "./card.tsx";

type MetricStatus = "success" | "warning" | "error";

const STATUS_TEXT: Record<MetricStatus, string> = {
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
};

type MetricCardProps = Omit<
  React.ComponentProps<typeof Card>,
  "size" | "title"
> & {
  label: React.ReactNode;
  /** A 16px icon before the label. */
  icon?: React.ReactNode;
  value?: React.ReactNode;
  /** What the value is measured against: a goal, last week. */
  caption?: React.ReactNode;
  /** How the metric is doing; colours the caption. */
  status?: MetricStatus;
  /** A trend beside the value, usually a `Sparkline`. */
  trend?: React.ReactNode;
  /** Top right: a range or metric picker. */
  action?: React.ReactNode;
};

/** A number, its label and what it compares to; children add a chart or a breakdown below. */
function MetricCard({
  label,
  icon,
  value,
  caption,
  status,
  trend,
  action,
  children,
  className,
  ...props
}: MetricCardProps) {
  return (
    <Card
      data-slot="metric-card"
      className={cn("@container/metric gap-6", className)}
      {...props}
    >
      <div className="flex flex-col gap-2">
        <div className="text-muted-foreground flex min-h-7 items-center gap-2 text-sm [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.33]">
          {icon}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {action}
        </div>
        {value !== undefined && (
          <div className="flex items-end gap-3">
            <span className="font-display tnum min-w-0 flex-1 truncate text-[2rem] leading-[1.15]">
              {value}
            </span>
            {trend}
          </div>
        )}
        {caption && (
          <p
            className={cn(
              "text-xs",
              status ? STATUS_TEXT[status] : "text-muted-foreground",
            )}
          >
            {caption}
          </p>
        )}
      </div>
      {children}
    </Card>
  );
}

export { MetricCard };
export type { MetricStatus };
