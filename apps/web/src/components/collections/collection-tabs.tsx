import { Badge } from "@decocms/ui/components/badge.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { KeyboardEvent, ReactNode } from "react";

export interface CollectionTab {
  id: string;
  label: ReactNode;
  count?: number;
}

export interface CollectionTabsProps {
  tabs: CollectionTab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  /** Names the view/filter switcher without pretending it owns a tabpanel. */
  ariaLabel: string;
  className?: string;
}

function focusAdjacentControl(
  event: KeyboardEvent<HTMLDivElement>,
  direction: "first" | "last" | "next" | "previous",
): void {
  const tabs = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>(
      "button[aria-pressed]:not([disabled])",
    ),
  );
  if (tabs.length === 0) return;

  const currentIndex = tabs.findIndex((tab) => tab === event.target);
  const targetIndex =
    direction === "first"
      ? 0
      : direction === "last"
        ? tabs.length - 1
        : direction === "next"
          ? (Math.max(currentIndex, 0) + 1) % tabs.length
          : (currentIndex <= 0 ? tabs.length : currentIndex) - 1;
  const target = tabs[targetIndex];
  if (!target) return;

  event.preventDefault();
  target.focus();
}

export function CollectionTabs({
  tabs,
  activeTab,
  onTabChange,
  ariaLabel,
  className,
}: CollectionTabsProps) {
  return (
    <div
      role="toolbar"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      onKeyDown={(event) => {
        if (event.key === "Home") focusAdjacentControl(event, "first");
        if (event.key === "End") focusAdjacentControl(event, "last");
        if (event.key === "ArrowRight") focusAdjacentControl(event, "next");
        if (event.key === "ArrowLeft") focusAdjacentControl(event, "previous");
      }}
      className={cn(
        "flex items-center gap-2 overflow-x-auto no-scrollbar",
        className,
      )}
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            aria-pressed={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onTabChange(tab.id)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-lg border border-input px-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
              isActive && "bg-accent border-border text-foreground",
              !isActive &&
                "bg-transparent text-muted-foreground hover:border-border hover:bg-accent/50 hover:text-foreground",
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <Badge
                variant="secondary"
                className={cn(
                  "h-5 min-w-5 px-1 rounded-full text-[10px] font-mono inline-flex items-center justify-center",
                  isActive
                    ? "bg-background text-foreground"
                    : "bg-muted-foreground/10 text-muted-foreground",
                )}
              >
                {tab.count}
              </Badge>
            )}
          </button>
        );
      })}
    </div>
  );
}
