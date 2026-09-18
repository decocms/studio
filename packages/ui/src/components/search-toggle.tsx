"use client";

import { useState } from "react";
import { SearchMd, X } from "@untitledui/icons";

import { cn } from "../lib/utils.ts";
import { IconButton } from "./icon-button.tsx";

interface SearchToggleProps {
  value: string;
  onChange: (next: string) => void;
  /** Tooltip and accessible name for the collapsed button. */
  label?: string;
  placeholder?: string;
  clearLabel?: string;
  /** Stay open and fill the width — a drawer or a narrow panel, where there is
   *  no room to trade a field for a button. */
  expanded?: boolean;
  className?: string;
}

/**
 * SearchToggle — a toolbar search that is an icon button until it is used.
 *
 * The collapsed state IS {@link IconButton}, so it sits beside other toolbar
 * controls without a single class of its own: hover, the focus ring, the glyph
 * size and the hit area all come from there. Use {@link SearchInput} instead
 * when the field should always be visible, as on a list page.
 *
 * Swapping a button for a field loses a width transition, so the field animates
 * in from the button's own width.
 */
function SearchToggle({
  value,
  onChange,
  label = "Search",
  placeholder = "Search…",
  clearLabel = "Clear search",
  expanded,
  className,
}: SearchToggleProps) {
  const [open, setOpen] = useState(value !== "");
  const [focused, setFocused] = useState(false);

  // Collapse a value cleared from OUTSIDE while unfocused — not one the person
  // is in the middle of deleting.
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    if (value === "" && !focused) setOpen(false);
  }

  if (!open && !expanded) {
    return (
      <IconButton
        label={label}
        tooltipSide="bottom"
        variant="secondary"
        onClick={() => setOpen(true)}
      >
        <SearchMd />
      </IconButton>
    );
  }

  return (
    <div
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 overflow-hidden rounded-full bg-card text-card-foreground card-shadow",
        expanded
          ? "h-10 w-full px-3"
          : "h-7 w-32 animate-search-expand px-2.5 sm:w-44",
        className,
      )}
    >
      {/* Decoration: the button it replaced is the collapsed state. */}
      <SearchMd className="size-4 shrink-0 text-muted-foreground" />
      <input
        autoFocus={!expanded}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          if (value === "") setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onChange("");
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className={cn(
          "w-full min-w-0 bg-transparent outline-none placeholder:text-muted-foreground",
          expanded ? "text-sm" : "text-xs",
        )}
      />
      {value !== "" && (
        <button
          type="button"
          aria-label={clearLabel}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onChange("");
            if (!expanded) setOpen(false);
          }}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export { SearchToggle };
export type { SearchToggleProps };
