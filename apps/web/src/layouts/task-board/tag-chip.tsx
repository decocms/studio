import { X } from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { tagDotColor } from "./config";

const CHIP =
  "inline-flex h-5 max-w-full shrink-0 items-center gap-1.5 rounded-(--radius-s) bg-muted px-1.5 text-xs font-medium text-foreground";

/** The one label chip for a task tag: a neutral chip with the tag's colour as a dot, on cards and in the dialog alike. */
export function TagChip({
  name,
  color,
  onSelect,
  onRemove,
  removeLabel,
}: {
  name: string;
  color: string | null | undefined;
  /** Makes the label a button, e.g. to reopen the tag picker. */
  onSelect?: () => void;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  const label = (
    <>
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: tagDotColor(color) }}
      />
      <span className="truncate">{name}</span>
    </>
  );

  if (!onSelect && !onRemove) return <span className={CHIP}>{label}</span>;

  return (
    // Sibling buttons, not nested: a <button> can't validly contain another interactive element.
    <span className={cn(CHIP, onRemove && "pr-0.5")}>
      {onSelect ? (
        <button
          type="button"
          onClick={onSelect}
          className="inline-flex min-w-0 items-center gap-1.5 rounded-(--radius-s) focus-ring"
        >
          {label}
        </button>
      ) : (
        label
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel}
          onClick={onRemove}
          className="flex size-4 shrink-0 items-center justify-center rounded-(--radius-s) text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-ring"
        >
          <X size={12} />
        </button>
      )}
    </span>
  );
}

/** The "+N" after a capped run of tag chips, in the same chip. */
export function TagOverflowChip({ count }: { count: number }) {
  return (
    <span className={cn(CHIP, "text-muted-foreground tabular-nums")}>
      +{count}
    </span>
  );
}
