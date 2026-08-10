import type { ReactElement } from "react";
import { useState } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Input } from "@decocms/ui/components/input.tsx";
import { CheckCircle, SearchSm } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";

export interface SelectableOption {
  value: string;
  label: string;
}

export function SelectableList({
  options,
  value,
  onChange,
  disabled,
  ariaLabel,
  searchPlaceholder,
  hideSearch = false,
}: {
  options: SelectableOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  // Required: this is the radiogroup's only accessible-name source, so every
  // variant must supply one rather than shipping an unlabeled picker.
  ariaLabel: string;
  searchPlaceholder?: string;
  // Hide the built-in client-side search box when the caller drives filtering
  // itself (e.g. a server-side repo search). Options are then rendered as-is.
  hideSearch?: boolean;
}): ReactElement {
  const t = useT();
  const [query, setQuery] = useState("");

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? options.filter((o) => o.label.toLowerCase().includes(normalizedQuery))
    : options;

  const flatValues = filtered.map((o) => o.value);
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
    <div className="space-y-2">
      {hideSearch ? null : (
        <div className="relative">
          <SearchSm
            size={16}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={disabled}
            placeholder={
              searchPlaceholder ??
              t("commerceOnboarding.selectableList.searchPlaceholder")
            }
            aria-label={t("commerceOnboarding.selectableList.searchAriaLabel", {
              label: ariaLabel,
            })}
            className="h-8 pl-8"
          />
        </div>
      )}

      <div
        role="radiogroup"
        aria-label={ariaLabel}
        className="max-h-[280px] overflow-y-auto"
      >
        {filtered.length === 0 ? (
          <div className="px-2 py-2 text-sm text-muted-foreground">
            {t("commerceOnboarding.selectableList.noResults")}
          </div>
        ) : (
          filtered.map((option) => {
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
          })
        )}
      </div>
    </div>
  );
}
