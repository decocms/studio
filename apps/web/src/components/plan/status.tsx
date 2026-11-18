import { cn } from "@decocms/ui/lib/utils.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import type { CheckStatus } from "./site-map-mock.ts";

export const STATUS_DOT: Record<CheckStatus, string> = {
  missing: "bg-destructive",
  partial: "bg-warning",
  done: "bg-success",
};
export const STATUS_RING: Record<CheckStatus, string> = {
  missing: "ring-destructive/20",
  partial: "ring-warning/20",
  done: "ring-success/20",
};
export const STATUS_BADGE: Record<
  CheckStatus,
  "destructive" | "warning" | "success"
> = {
  missing: "destructive",
  partial: "warning",
  done: "success",
};
export const STATUS_LABEL: Record<CheckStatus, TranslationKey> = {
  missing: "plan.map.status.missing",
  partial: "plan.map.status.partial",
  done: "plan.map.status.done",
};
export const STATUSES: CheckStatus[] = ["missing", "partial", "done"];

export function StatusDot({
  status,
  className,
}: {
  status: CheckStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        STATUS_DOT[status],
        className,
      )}
    />
  );
}
