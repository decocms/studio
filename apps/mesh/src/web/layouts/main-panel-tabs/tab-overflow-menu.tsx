/**
 * TabOverflowMenu — "..." dropdown listing tabs that don't fit in the bar.
 *
 * Rendered by MainPanelTabsBar only when there is at least one overflow
 * tab. Clicking a row calls onSelect(tab.id), which the bar routes
 * through the appropriate click handler; the popover auto-closes on
 * click via its standard behavior.
 */

import { useState } from "react";
import { DotsHorizontal } from "@untitledui/icons";
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
        <button
          type="button"
          title={t("mainPanelTabs.tabOverflowMenu.moreTabs")}
          aria-label={t("mainPanelTabs.tabOverflowMenu.moreTabs")}
          className="shrink-0 flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          <DotsHorizontal className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1">
        <ul className="flex flex-col">
          {overflow.map((tab) => (
            <li key={tab.id}>
              <button
                type="button"
                onClick={() => handleClick(tab.id)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-md hover:bg-accent text-sm text-foreground"
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
