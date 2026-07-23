/**
 * TabOverflowMenu — the stack button that opens a popover listing the buttons
 * that don't fit in the bar.
 *
 * Rendered by MainPanelTabsBar only when there is at least one overflow item.
 * Clicking a row calls onSelect(id), which the bar routes through the item's
 * handler (and promotes it into the visible bar); the popover closes on click.
 */

import { useState } from "react";
import { LayersThree01 } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { useT } from "@/web/i18n/use-t.ts";
import type { TabIcon } from "./resolve-tab-icon";
import { TabIconGlyph } from "./tab-icon-glyph";

type OverflowTab = {
  id: string;
  title: string;
  icon: TabIcon;
  active?: boolean;
};

export function TabOverflowMenu({
  overflow,
  onSelect,
}: {
  overflow: OverflowTab[];
  onSelect: (id: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  const handleClick = (id: string) => {
    setOpen(false);
    onSelect(id);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* Matches the 28px icon-only tab-button metrics. */}
        <button
          type="button"
          data-tour="tour-dropdown"
          title={t("mainPanelTabs.tabOverflowMenu.moreTabs")}
          aria-label={t("mainPanelTabs.tabOverflowMenu.moreTabs")}
          className={cn(
            "shrink-0 flex size-7 items-center justify-center rounded-md",
            "[transition:background-color_180ms_ease,color_180ms_ease]",
            open
              ? "bg-sidebar-accent text-sidebar-foreground"
              : "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground",
          )}
        >
          <LayersThree01 className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">
        <ul className="flex flex-col">
          {overflow.map((tab) => (
            <li key={tab.id}>
              <button
                type="button"
                onClick={() => handleClick(tab.id)}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm",
                  tab.active
                    ? "bg-sidebar-accent text-sidebar-foreground"
                    : "text-foreground hover:bg-accent",
                )}
              >
                <span className="flex size-5 items-center justify-center shrink-0">
                  <TabIconGlyph icon={tab.icon} />
                </span>
                <span className="truncate">{tab.title}</span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
