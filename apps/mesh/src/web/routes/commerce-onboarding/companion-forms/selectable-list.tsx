import type { ReactElement } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { CheckCircle } from "@untitledui/icons";

export interface SelectableOption {
  value: string;
  label: string;
}

export interface SelectableGroup {
  label?: string;
  options: SelectableOption[];
}

export function SelectableList({
  groups,
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  groups: SelectableGroup[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
}): ReactElement {
  const flatValues = groups.flatMap((g) => g.options.map((o) => o.value));

  const tabbableValue = flatValues.includes(value)
    ? value
    : (flatValues[0] ?? "");

  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;

    const handled = [
      "ArrowDown",
      "ArrowRight",
      "ArrowUp",
      "ArrowLeft",
      "Home",
      "End",
    ].includes(e.key);
    if (!handled) return;

    e.preventDefault();

    const currentValue = (e.currentTarget as HTMLButtonElement).dataset.value!;
    const currentIndex = flatValues.indexOf(currentValue);
    const len = flatValues.length;
    if (len === 0) return;

    let nextIndex: number;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % len;
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + len) % len;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else {
      // End
      nextIndex = len - 1;
    }

    const nextValue = flatValues[nextIndex]!;
    onChange(nextValue);

    const container = e.currentTarget.closest('[role="radiogroup"]');
    const nextButton = container?.querySelector<HTMLButtonElement>(
      `[data-value="${CSS.escape(nextValue)}"]`,
    );
    nextButton?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="min-h-[200px] max-h-[280px] overflow-y-auto rounded-md border border-border bg-background p-1"
    >
      {groups.map((group, groupIndex) => (
        <div key={group.label ?? `group-${groupIndex}`}>
          {group.label ? (
            <div className="px-2 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {group.label}
            </div>
          ) : null}
          {group.options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled}
                data-value={option.value}
                tabIndex={option.value === tabbableValue ? 0 : -1}
                onClick={() => onChange(option.value)}
                onKeyDown={handleKeyDown}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-sm px-2 py-2 text-left text-sm",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  "disabled:pointer-events-none disabled:opacity-50",
                  selected
                    ? "bg-muted font-medium text-foreground"
                    : "text-foreground hover:bg-muted/50",
                )}
              >
                <span className="truncate">{option.label}</span>
                {selected ? (
                  <CheckCircle size={16} className="shrink-0 text-primary" />
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
