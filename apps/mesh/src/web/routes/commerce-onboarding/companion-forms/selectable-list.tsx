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
}: {
  groups: SelectableGroup[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}): ReactElement {
  return (
    <div
      role="radiogroup"
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
                onClick={() => onChange(option.value)}
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
