import { cn } from "@decocms/ui/lib/utils.ts";
import { Spinner } from "@decocms/ui/components/spinner.tsx";

export function LoadingIndicator({
  label,
  iconSize = 14,
  className,
  iconClassName,
  labelClassName,
}: {
  label: string;
  iconSize?: number;
  className?: string;
  iconClassName?: string;
  labelClassName?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <Spinner
        className={cn("shrink-0", iconClassName)}
        style={{ width: iconSize, height: iconSize }}
      />
      <span className={cn("text-sm", labelClassName)}>{label}</span>
    </span>
  );
}
