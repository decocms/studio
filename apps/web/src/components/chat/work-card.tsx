import type { ReactNode } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";

/** One frame for the work a chat did (a draft, a task): what, where, state. */
export function WorkCard({
  icon,
  title,
  subtitle,
  status,
  detail,
  action,
  className,
}: {
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  status?: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("rounded-xl border border-border bg-card p-3", className)}
    >
      <div className="flex items-center gap-2.5">
        <div className="shrink-0">{icon}</div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {title}
          </p>
          {subtitle && (
            <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {status && (
          <span className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
            {status}
          </span>
        )}
      </div>
      {(detail || action) && (
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground">{detail}</span>
          {action}
        </div>
      )}
    </div>
  );
}
