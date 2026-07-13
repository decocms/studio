import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "@untitledui/icons";

/**
 * Small uppercase section label that doubles as an accordion toggle. Shared by
 * the sidebar's Team threads / My threads / Agents sections so they read as
 * peers. Optional trailing `action` (e.g. "See all") reveals on header hover.
 */
export function SidebarSectionHeader({
  label,
  open,
  onToggle,
  count,
  action,
  actionSlot,
  controlsId,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  count?: number;
  action?: { label: string; icon?: ReactNode; onClick: () => void };
  /** Arbitrary always-visible trailing control (e.g. a browse-agents "+"). */
  actionSlot?: ReactNode;
  /** id of the collapsible content panel this header toggles (a11y). */
  controlsId?: string;
}) {
  return (
    <div className="group/section flex items-center gap-1 px-2 pb-0.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={controlsId}
        onClick={onToggle}
        className="flex flex-1 min-w-0 items-center gap-1 text-sm font-medium text-muted-foreground/80 hover:text-foreground transition-colors focus-visible:outline-none"
      >
        {open ? (
          <ChevronDown size={12} className="shrink-0" />
        ) : (
          <ChevronRight size={12} className="shrink-0" />
        )}
        <span className="truncate">{label}</span>
        {typeof count === "number" && count > 0 && (
          <span className="tabular-nums text-muted-foreground/60">{count}</span>
        )}
      </button>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="shrink-0 flex items-center gap-0.5 text-sm font-medium text-muted-foreground/60 hover:text-foreground opacity-0 group-hover/section:opacity-100 focus-visible:opacity-100 transition-opacity focus-visible:outline-none"
        >
          {action.label}
          {action.icon}
        </button>
      )}
      {actionSlot}
    </div>
  );
}
