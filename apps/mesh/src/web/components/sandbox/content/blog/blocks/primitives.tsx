import { Plus, Trash01 } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.js";

/**
 * Borderless auto-growing text input shared by the block editors. Grows
 * with content via `field-sizing:content`, with a JS fallback on input.
 * Single logical line of text that wraps — Enter is left to callers.
 */
export function InlineText({
  value,
  onChange,
  placeholder,
  className,
  onFocus,
  onBlur,
  onKeyDown,
  spellCheck = true,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  onFocus?: () => void;
  onBlur?: (e: React.FocusEvent<HTMLTextAreaElement>) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  spellCheck?: boolean;
  inputRef?: (el: HTMLTextAreaElement | null) => void;
}) {
  return (
    <textarea
      ref={inputRef}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onInput={(e) => {
        const el = e.currentTarget;
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
      }}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      spellCheck={spellCheck}
      rows={1}
      className={cn(
        "w-full resize-none border-0 bg-transparent p-0 outline-none [field-sizing:content] placeholder:text-muted-foreground/50 focus:ring-0",
        className,
      )}
    />
  );
}

/** Faint field label used inside structured blocks. */
export function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block text-[11px] font-medium text-muted-foreground/60">
      {children}
    </span>
  );
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** "Add row" affordance for collection blocks. */
export function AddButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1.5 rounded-md border border-dashed px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-40 disabled:hover:border-dashed disabled:hover:text-muted-foreground cursor-pointer"
    >
      <Plus size={13} />
      {label}
    </button>
  );
}

/** Small "remove this row" icon button revealed on hover of a collection item. */
export function RemoveButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:text-destructive group-hover/item:opacity-100 cursor-pointer"
    >
      <Trash01 size={13} />
    </button>
  );
}

/** A floating segmented control shown above a focused block (variant/level). */
export function FloatingToolbar({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute -top-9 left-0 z-10 flex items-center gap-0.5 rounded-md border bg-popover p-0.5 shadow-md">
      {children}
    </div>
  );
}

export function ToolbarButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex h-7 min-w-7 items-center justify-center rounded px-1.5 text-sm transition-colors cursor-pointer",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** Parse a JSON-encoded array field, tolerating malformed/empty input. */
export function parseJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
