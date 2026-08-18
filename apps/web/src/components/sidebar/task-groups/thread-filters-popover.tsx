/**
 * The thread list's View / Type / Scope filter popover, shared by the sidebar
 * list and the chat panel's threads menu. Reads and writes the state owned by
 * `useThreadsPanel`.
 */

import type { ReactNode } from "react";
import { Activity, FilterLines, Rows01 } from "@untitledui/icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@decocms/ui/components/toggle-group.tsx";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t.ts";
import type { ThreadsPanel } from "./use-threads-panel";

/** One labelled segmented control (View / Type / Scope) in the popover. */
function FilterRow<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; icon?: ReactNode }[];
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <ToggleGroup
        type="single"
        size="sm"
        value={value}
        onValueChange={(v) => v && onChange(v as T)}
        className="gap-0.5 rounded-lg border border-border bg-muted/50 p-0.5"
      >
        {options.map((opt) => (
          <ToggleGroupItem
            key={opt.value}
            value={opt.value}
            className="h-6 gap-1.5 rounded-md border border-transparent px-2 text-xs font-medium text-muted-foreground hover:bg-transparent data-[state=on]:border-border data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
          >
            {opt.icon}
            {opt.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

export function ThreadFiltersPopover({
  panel,
  className = "md:size-[34px] rounded-lg",
}: {
  panel: ThreadsPanel;
  className?: string;
}) {
  const t = useT();
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
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
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t("sidebar.taskGroupsList.filterChats")}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-64 flex flex-col gap-3 p-3">
        <FilterRow
          label={t("sidebar.taskGroupsList.filterView")}
          value={panel.groupBy}
          onChange={(v) => {
            track("tasks_panel_group_by_changed", { to_value: v });
            panel.setGroupBy(v);
          }}
          options={[
            {
              value: "flat",
              label: t("sidebar.taskGroupsList.viewList"),
              icon: <Rows01 size={13} />,
            },
            {
              value: "status",
              label: t("sidebar.taskGroupsList.viewStatus"),
              icon: <Activity size={13} />,
            },
          ]}
        />
        <FilterRow
          label={t("sidebar.taskGroupsList.filterType")}
          value={panel.typeFilter}
          onChange={(v) => {
            track("tasks_panel_filter_changed", { to_value: v });
            panel.setTypeFilter(v);
          }}
          options={[
            { value: "all", label: t("sidebar.taskGroupsList.typeAll") },
            { value: "manual", label: t("sidebar.taskGroupsList.typeChats") },
            {
              value: "automation",
              label: t("sidebar.taskGroupsList.typeAuto"),
            },
          ]}
        />
        <FilterRow
          label={t("sidebar.taskGroupsList.filterScope")}
          value={panel.showAll ? "team" : "mine"}
          onChange={(v) => panel.setShowAll(v === "team")}
          options={[
            { value: "mine", label: t("sidebar.taskGroupsList.scopeMine") },
            { value: "team", label: t("sidebar.taskGroupsList.scopeTeam") },
          ]}
        />
      </PopoverContent>
    </Popover>
  );
}
