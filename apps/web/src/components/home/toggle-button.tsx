import { cn } from "@deco/ui/lib/utils.ts";
import { Loading01, Minus, Plus } from "@untitledui/icons";

export function ToggleButton({
  isPinned,
  submitting,
  onClick,
  label,
}: {
  isPinned: boolean;
  submitting: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={submitting}
      aria-label={label}
      aria-pressed={isPinned}
      title={label}
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-xs transition-colors disabled:opacity-50 disabled:cursor-progress",
        isPinned
          ? "text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          : "bg-foreground text-background hover:opacity-90",
      )}
    >
      {submitting ? (
        <Loading01 size={12} className="animate-spin" />
      ) : isPinned ? (
        <Minus size={14} />
      ) : (
        <Plus size={14} />
      )}
    </button>
  );
}
