import { cn } from "@decocms/ui/lib/utils.ts";
import { Loading01 } from "@untitledui/icons";

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
      <Loading01
        size={iconSize}
        className={cn("shrink-0 animate-spin", iconClassName)}
      />
      <span className={cn("text-sm", labelClassName)}>{label}</span>
    </span>
  );
}
