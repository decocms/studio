/** The chat list's menu for grouping and whose chats it shows. */

import { Check, FilterLines } from "@untitledui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t.ts";
import type { ThreadGroupBy, ThreadsPanel } from "./use-threads-panel";

function Choice({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <span className="flex-1 truncate">{label}</span>
      {selected && <Check size={14} className="shrink-0" />}
    </DropdownMenuItem>
  );
}

export function ThreadFiltersPopover({
  panel,
  className = "md:size-[34px]",
}: {
  panel: ThreadsPanel;
  className?: string;
}) {
  const t = useT();
  const groupBy = (value: ThreadGroupBy) => {
    track("tasks_panel_group_by_changed", { to_value: value });
    panel.setGroupBy(value);
  };
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <ToolbarIconButton
              aria-label={t("sidebar.taskGroupsList.filterChats")}
              active={panel.filtersActive}
              className={className}
            >
              <FilterLines size={16} />
              {panel.filtersActive && (
                <span className="absolute right-1 top-1 size-1.5 rounded-full bg-primary ring-2 ring-sidebar" />
              )}
            </ToolbarIconButton>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t("sidebar.taskGroupsList.filterChats")}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t("sidebar.taskGroupsList.filterView")}
        </DropdownMenuLabel>
        <Choice
          label={t("sidebar.taskGroupsList.viewList")}
          selected={panel.groupBy === "flat"}
          onSelect={() => groupBy("flat")}
        />
        <Choice
          label={t("sidebar.taskGroupsList.viewStatus")}
          selected={panel.groupBy === "status"}
          onSelect={() => groupBy("status")}
        />
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t("sidebar.taskGroupsList.filterScope")}
        </DropdownMenuLabel>
        <Choice
          label={t("sidebar.taskGroupsList.scopeMine")}
          selected={!panel.showAll}
          onSelect={() => panel.setShowAll(false)}
        />
        <Choice
          label={t("sidebar.taskGroupsList.scopeTeam")}
          selected={panel.showAll}
          onSelect={() => panel.setShowAll(true)}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
