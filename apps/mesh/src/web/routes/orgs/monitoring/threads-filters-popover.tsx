import { useState } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { MultiSelect } from "@deco/ui/components/multi-select.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { FilterLines } from "@untitledui/icons";
import { useT } from "@/web/i18n/use-t.ts";

interface ThreadsFiltersPopoverProps {
  filterAgentIds: string[];
  filterUserIds: string[];
  filterStatus: string;
  virtualMcpOptions: Array<{ value: string; label: string }>;
  memberOptions: Array<{ value: string; label: string }>;
  activeFiltersCount: number;
  onUpdateFilters: (updates: {
    filterAgentIds?: string[];
    filterUserIds?: string[];
    filterStatus?: string;
  }) => void;
}

export function ThreadsFiltersPopover({
  filterAgentIds,
  filterUserIds,
  filterStatus,
  virtualMcpOptions,
  memberOptions,
  activeFiltersCount,
  onUpdateFilters,
}: ThreadsFiltersPopoverProps) {
  const [open, setOpen] = useState(false);
  const t = useT();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="relative">
          <FilterLines size={16} />
          <span className="hidden sm:inline">
            {t("orgs.threadsFiltersPopover.filters")}
          </span>
          {activeFiltersCount > 0 && (
            <>
              <Badge
                variant="default"
                className="sm:hidden absolute -top-1.5 -right-1.5 h-4 min-w-4 px-1 text-[10px] leading-none"
              >
                {activeFiltersCount}
              </Badge>
              <Badge
                variant="default"
                className="hidden sm:flex ml-1 h-5 w-5 rounded-full p-0 items-center justify-center text-xs"
              >
                {activeFiltersCount}
              </Badge>
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[280px]">
        <div className="space-y-4">
          <h4 className="font-medium text-sm">
            {t("orgs.threadsFiltersPopover.filterChats")}
          </h4>

          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                {t("orgs.threadsFiltersPopover.agent")}
              </label>
              <MultiSelect
                options={virtualMcpOptions}
                defaultValue={filterAgentIds}
                onValueChange={(values) =>
                  onUpdateFilters({ filterAgentIds: values.slice(0, 1) })
                }
                placeholder={t("orgs.threadsFiltersPopover.allAgents")}
                variant="secondary"
                className="w-full"
                maxCount={1}
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                {t("orgs.threadsFiltersPopover.user")}
              </label>
              <MultiSelect
                options={memberOptions}
                defaultValue={filterUserIds}
                onValueChange={(values) =>
                  onUpdateFilters({ filterUserIds: values.slice(0, 1) })
                }
                placeholder={t("orgs.threadsFiltersPopover.allUsers")}
                variant="secondary"
                className="w-full"
                maxCount={1}
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                {t("orgs.threadsFiltersPopover.status")}
              </label>
              <Select
                value={filterStatus}
                onValueChange={(value) =>
                  onUpdateFilters({ filterStatus: value })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {t("orgs.threadsFiltersPopover.allStatuses")}
                  </SelectItem>
                  <SelectItem value="completed">
                    {t("orgs.threadsFiltersPopover.completed")}
                  </SelectItem>
                  <SelectItem value="active">
                    {t("orgs.threadsFiltersPopover.active")}
                  </SelectItem>
                  <SelectItem value="failed">
                    {t("orgs.threadsFiltersPopover.failed")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {activeFiltersCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => {
                onUpdateFilters({
                  filterAgentIds: [],
                  filterUserIds: [],
                  filterStatus: "all",
                });
                setOpen(false);
              }}
            >
              {t("orgs.threadsFiltersPopover.clearAllFilters")}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
