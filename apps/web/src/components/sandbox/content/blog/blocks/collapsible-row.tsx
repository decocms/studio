/**
 * A list where each row shows one line and opens to its fields.
 *
 * The brand's rules, a campaign's targets and its highlighted products are all
 * records with one obvious title and several fields behind it, and a column of
 * open forms is unreadable past two entries. Only the shell is shared — each
 * caller owns which row is open, because the lists differ in what closing one
 * should do.
 */

import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { RemoveButton } from "./primitives";

export function CollapsibleList({ children }: { children: ReactNode }) {
  return (
    <ul className="divide-y overflow-hidden rounded-lg border">{children}</ul>
  );
}

export function CollapsibleRow({
  open,
  onToggle,
  title,
  untitledLabel,
  removeLabel,
  onRemove,
  leading,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  title: string;
  /** Stands in while the entry has no name yet — a blank row is unclickable. */
  untitledLabel: string;
  removeLabel: string;
  onRemove: () => void;
  /** Thumbnail or badge shown before the title. */
  leading?: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="group/item bg-card">
      <div className="flex items-center gap-1 pr-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/50"
        >
          {open ? (
            <ChevronDown size={14} className="shrink-0" />
          ) : (
            <ChevronRight
              size={14}
              className="shrink-0 text-muted-foreground"
            />
          )}
          {leading}
          <span className={cn("truncate", !title && "text-muted-foreground")}>
            {title || untitledLabel}
          </span>
        </button>
        <RemoveButton label={removeLabel} onClick={onRemove} />
      </div>
      {open && children}
    </li>
  );
}
