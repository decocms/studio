/**
 * Monitoring Dashboard Route
 *
 * Tab switcher + shared state. Delegates to overview, audit, and threads tabs.
 */

import { SearchInput } from "@deco/ui/components/search-input.tsx";
import { Page } from "@/web/components/page";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { MONITORING_CONFIG } from "@/web/components/monitoring/config.ts";
import type { DateRange } from "@/web/components/monitoring/monitoring-stats-row.tsx";
import {
  type MonitoringSearchParams,
  type PropertyFilter,
  type PropertyFilterOperator,
  deserializePropertyFilters,
  serializePropertyFilters,
  propertyFiltersToApiParams,
  propertyFiltersToRaw,
  parseRawPropertyFilters,
} from "@/web/components/monitoring";
import { useMembers } from "@/web/hooks/use-members";
import {
  SELF_MCP_ALIAS_ID,
  WellKnownOrgMCPId,
  useConnections,
  useMCPClient,
  useProjectContext,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { FilterLines, Container } from "@untitledui/icons";
import { Input } from "@deco/ui/components/input.tsx";
import { MultiSelect } from "@deco/ui/components/multi-select.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import {
  TimeRangePicker,
  type TimeRange as TimeRangeValue,
} from "@deco/ui/components/time-range-picker.tsx";
import { expressionToDate } from "@deco/ui/lib/time-expressions.ts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Suspense, useRef, useState } from "react";
import { Plus, Trash01, Code01, Grid01 } from "@untitledui/icons";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { CollectionTabs } from "@/web/components/collections/collection-tabs.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { Avatar } from "@deco/ui/components/avatar.tsx";

import { OverviewTabContent, OverviewTabSkeleton } from "./overview.tsx";
import { AuditTabContent, MonitoringLogsTable } from "./audit.tsx";
import { ThreadsTabContent, ThreadsFiltersPopover } from "./threads.tsx";
import { getOrgMembers } from "./utils.ts";
import { track } from "@/web/lib/posthog-client";

// ============================================================================
// Filters Popover Component
// ============================================================================

interface FiltersPopoverProps {
  connectionIds: string[];
  virtualMcpIds: string[];
  tool: string;
  status: string;
  hideSystem: boolean;
  propertyFilters: PropertyFilter[];
  connectionOptions: Array<{ value: string; label: string }>;
  virtualMcpOptions: Array<{ value: string; label: string }>;
  activeFiltersCount: number;
  onUpdateFilters: (updates: Partial<MonitoringSearchParams>) => void;
  connectionSearchTerm?: string;
  onConnectionSearchChange?: (term: string) => void;
}

const OPERATOR_OPTIONS: Array<{
  value: PropertyFilterOperator;
  label: string;
}> = [
  { value: "eq", label: "equals" },
  { value: "contains", label: "contains" },
  { value: "in", label: "in (list)" },
  { value: "exists", label: "exists" },
];

function FiltersPopover({
  connectionIds,
  virtualMcpIds,
  tool,
  status,
  hideSystem,
  propertyFilters,
  connectionOptions,
  virtualMcpOptions,
  activeFiltersCount,
  onUpdateFilters,
  onConnectionSearchChange,
}: FiltersPopoverProps) {
  const [filterPopoverOpen, setFilterPopoverOpen] = useState(false);
  const [propertyFilterMode, setPropertyFilterMode] = useState<"raw" | "form">(
    "form",
  );

  const [localTool, setLocalTool] = useState(tool);
  const [localPropertyFilters, setLocalPropertyFilters] =
    useState<PropertyFilter[]>(propertyFilters);
  const [localRawFilters, setLocalRawFilters] = useState(
    propertyFiltersToRaw(propertyFilters),
  );

  const prevToolRef = useRef(tool);
  const prevPropertyFiltersRef = useRef(
    serializePropertyFilters(propertyFilters),
  );

  if (prevToolRef.current !== tool) {
    prevToolRef.current = tool;
    if (localTool !== tool) {
      setLocalTool(tool);
    }
  }

  const currentSerialized = serializePropertyFilters(propertyFilters);
  if (prevPropertyFiltersRef.current !== currentSerialized) {
    prevPropertyFiltersRef.current = currentSerialized;
    setLocalPropertyFilters(propertyFilters);
    setLocalRawFilters(propertyFiltersToRaw(propertyFilters));
  }

  const updatePropertyFilter = (
    index: number,
    updates: Partial<PropertyFilter>,
  ) => {
    const newFilters = [...localPropertyFilters];
    const existing = newFilters[index];
    if (!existing) return;
    newFilters[index] = {
      key: updates.key ?? existing.key,
      operator: updates.operator ?? existing.operator,
      value: updates.value ?? existing.value,
    };
    setLocalPropertyFilters(newFilters);
  };

  const addPropertyFilter = () => {
    setLocalPropertyFilters([
      ...localPropertyFilters,
      { key: "", operator: "eq", value: "" },
    ]);
  };

  const removePropertyFilter = (index: number) => {
    const newFilters = localPropertyFilters.filter((_, i) => i !== index);
    setLocalPropertyFilters(newFilters);
    setLocalRawFilters(propertyFiltersToRaw(newFilters));
    onUpdateFilters({ propertyFilters: serializePropertyFilters(newFilters) });
  };

  const applyPropertyFilters = () => {
    onUpdateFilters({
      propertyFilters: serializePropertyFilters(localPropertyFilters),
    });
  };

  const applyRawFilters = () => {
    const parsed = parseRawPropertyFilters(localRawFilters);
    setLocalPropertyFilters(parsed);
    onUpdateFilters({
      propertyFilters: serializePropertyFilters(parsed),
    });
  };

  const toggleMode = () => {
    if (propertyFilterMode === "raw") {
      const parsed = parseRawPropertyFilters(localRawFilters);
      setLocalPropertyFilters(parsed);
      setPropertyFilterMode("form");
    } else {
      setLocalRawFilters(propertyFiltersToRaw(localPropertyFilters));
      setPropertyFilterMode("raw");
    }
  };

  return (
    <Popover open={filterPopoverOpen} onOpenChange={setFilterPopoverOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="relative">
          <FilterLines size={16} />
          <span className="hidden sm:inline">Filters</span>
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
      <PopoverContent align="end" className="w-[320px]">
        <div className="space-y-4">
          <div>
            <h4 className="font-medium text-sm mb-3">Filter Logs</h4>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label
                htmlFor="hide-system-calls"
                className="text-xs font-medium text-muted-foreground cursor-pointer"
              >
                Hide system calls
              </Label>
              <Switch
                id="hide-system-calls"
                checked={hideSystem}
                onCheckedChange={(checked) =>
                  onUpdateFilters({ hideSystem: !!checked })
                }
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Connections
              </label>
              <MultiSelect
                options={connectionOptions}
                defaultValue={connectionIds}
                onValueChange={(values) =>
                  onUpdateFilters({ connectionId: values })
                }
                onSearchChange={onConnectionSearchChange}
                placeholder="All servers"
                variant="secondary"
                className="w-full"
                maxCount={2}
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Agents
              </label>
              <MultiSelect
                options={virtualMcpOptions}
                defaultValue={virtualMcpIds}
                onValueChange={(values) =>
                  onUpdateFilters({ virtualMcpId: values })
                }
                placeholder="All Agents"
                variant="secondary"
                className="w-full"
                maxCount={2}
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Tool Name
              </label>
              <Input
                id="filter-tool"
                placeholder="Filter by tool..."
                value={localTool}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setLocalTool(e.target.value)
                }
                onBlur={() => {
                  if (localTool !== tool) {
                    onUpdateFilters({ tool: localTool });
                  }
                }}
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === "Enter" && localTool !== tool) {
                    onUpdateFilters({ tool: localTool });
                  }
                }}
                className="w-full"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Status
              </label>
              <Select
                value={status}
                onValueChange={(value: string) =>
                  onUpdateFilters({
                    status: value as MonitoringSearchParams["status"],
                  })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="success">Success Only</SelectItem>
                  <SelectItem value="errors">Errors Only</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-medium text-muted-foreground">
                  Property Filters
                </label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={toggleMode}
                    >
                      {propertyFilterMode === "raw" ? (
                        <Grid01 size={14} />
                      ) : (
                        <Code01 size={14} />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {propertyFilterMode === "raw"
                      ? "Switch to form view"
                      : "Switch to raw text"}
                  </TooltipContent>
                </Tooltip>
              </div>

              {propertyFilterMode === "raw" ? (
                <div className="space-y-1.5">
                  <Textarea
                    placeholder={`Paste property filters here:\nthread_id=abc123\nuser~test\ndebug?`}
                    value={localRawFilters}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                      setLocalRawFilters(e.target.value)
                    }
                    onBlur={applyRawFilters}
                    onKeyDown={(
                      e: React.KeyboardEvent<HTMLTextAreaElement>,
                    ) => {
                      if (e.key === "Enter" && e.metaKey) {
                        applyRawFilters();
                      }
                    }}
                    className="font-mono text-sm min-h-[80px] resize-none"
                  />
                  <p className="text-xs text-muted-foreground">
                    One per line:{" "}
                    <code className="bg-muted px-1 rounded">key=value</code>{" "}
                    <code className="bg-muted px-1 rounded">key~contains</code>{" "}
                    <code className="bg-muted px-1 rounded">key@in_list</code>{" "}
                    <code className="bg-muted px-1 rounded">key?</code>
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {localPropertyFilters.map((filter, index) => (
                    <div
                      key={index}
                      className="p-2.5 rounded-md border border-border bg-muted/30 space-y-2"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">
                          Filter {index + 1}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-muted-foreground hover:text-destructive"
                          onClick={() => removePropertyFilter(index)}
                        >
                          <Trash01 size={12} />
                        </Button>
                      </div>
                      <div className="flex gap-2">
                        <Input
                          placeholder="Key (e.g., thread_id)"
                          value={filter.key}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            updatePropertyFilter(index, { key: e.target.value })
                          }
                          onBlur={applyPropertyFilters}
                          onKeyDown={(
                            e: React.KeyboardEvent<HTMLInputElement>,
                          ) => {
                            if (e.key === "Enter") applyPropertyFilters();
                          }}
                          className="flex-1 font-mono text-sm"
                        />
                        <Select
                          value={filter.operator}
                          onValueChange={(value: PropertyFilterOperator) => {
                            const newFilters = [...localPropertyFilters];
                            const existing = newFilters[index];
                            if (existing) {
                              newFilters[index] = {
                                ...existing,
                                operator: value,
                                value: value === "exists" ? "" : existing.value,
                              };
                              setLocalPropertyFilters(newFilters);
                              onUpdateFilters({
                                propertyFilters:
                                  serializePropertyFilters(newFilters),
                              });
                            }
                          }}
                        >
                          <SelectTrigger className="w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {OPERATOR_OPTIONS.map((op) => (
                              <SelectItem key={op.value} value={op.value}>
                                {op.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {filter.operator !== "exists" && (
                        <Input
                          placeholder="Value"
                          value={filter.value}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            updatePropertyFilter(index, {
                              value: e.target.value,
                            })
                          }
                          onBlur={applyPropertyFilters}
                          onKeyDown={(
                            e: React.KeyboardEvent<HTMLInputElement>,
                          ) => {
                            if (e.key === "Enter") applyPropertyFilters();
                          }}
                          className="w-full font-mono text-sm"
                        />
                      )}
                    </div>
                  ))}
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={addPropertyFilter}
                  >
                    <Plus size={14} className="mr-1.5" />
                    Add filter
                  </Button>
                </div>
              )}
            </div>
          </div>

          {activeFiltersCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => {
                setLocalTool("");
                setLocalPropertyFilters([]);
                setLocalRawFilters("");
                onUpdateFilters({
                  connectionId: [],
                  virtualMcpId: [],
                  tool: "",
                  status: "all",
                  propertyFilters: "",
                });
                setFilterPopoverOpen(false);
              }}
            >
              Clear all filters
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ============================================================================
// Main Dashboard Content
// ============================================================================

interface MonitoringDashboardContentProps {
  tab: "overview" | "audit" | "threads";
  dateRange: DateRange;
  displayDateRange: DateRange;
  connectionIds: string[];
  virtualMcpIds: string[];
  tool: string;
  status: string;
  search: string;
  streaming: boolean;
  hideSystem: boolean;
  activeFiltersCount: number;
  from: string;
  to: string;
  propertyFilters: PropertyFilter[];
  onUpdateFilters: (updates: Partial<MonitoringSearchParams>) => void;
  onTimeRangeChange: (range: TimeRangeValue) => void;
  onStreamingToggle: () => void;
  onTabChange: (tab: "overview" | "audit" | "threads") => void;
}

function MonitoringDashboardContent({
  tab,
  dateRange,
  displayDateRange,
  connectionIds,
  virtualMcpIds,
  tool,
  status,
  search: searchQuery,
  streaming: isStreaming,
  hideSystem,
  activeFiltersCount,
  from,
  to,
  propertyFilters,
  onUpdateFilters,
  onTimeRangeChange,
  onStreamingToggle,
  onTabChange,
}: MonitoringDashboardContentProps) {
  const allConnections = useConnections();
  const allVirtualMcps = useVirtualMCPs();
  const { data: membersData } = useMembers();

  const [connectionSearch, setConnectionSearch] = useState("");
  const searchFilteredConnections = useConnections({
    searchTerm: connectionSearch || undefined,
  });
  const connectionOptions = (searchFilteredConnections ?? []).map((conn) => {
    const icon = conn.icon;
    const name = conn.title || conn.id;
    return {
      value: conn.id,
      label: name,
      icon: ({ className }: { className?: string }) => (
        <IntegrationIcon
          icon={icon}
          name={name}
          size="xs"
          fallbackIcon={<Container />}
          className={cn("size-4! min-w-4! rounded-sm shrink-0", className)}
        />
      ),
    };
  });
  const virtualMcpOptions = allVirtualMcps.map((vm) => {
    const icon = vm.icon;
    const name = vm.title ?? "Decopilot";
    return {
      value: vm.id ?? "",
      label: name,
      icon: ({ className }: { className?: string }) => (
        <IntegrationIcon
          icon={icon}
          name={name}
          size="xs"
          fallbackIcon={<Container />}
          className={cn("size-4! min-w-4! rounded-sm shrink-0", className)}
        />
      ),
    };
  });

  const { pageSize, streamingRefetchInterval } = MONITORING_CONFIG;
  const { org, locator } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const propertyApiParams = propertyFiltersToApiParams(propertyFilters);

  const excludeConnectionIds = hideSystem
    ? [WellKnownOrgMCPId.SELF(org.id)]
    : undefined;

  // Threads-specific filter state
  const [threadFilterAgentIds, setThreadFilterAgentIds] = useState<string[]>(
    [],
  );
  const [threadFilterUserIds, setThreadFilterUserIds] = useState<string[]>([]);
  const [threadFilterStatus, setThreadFilterStatus] = useState("all");

  const threadActiveFiltersCount =
    (threadFilterAgentIds.length > 0 ? 1 : 0) +
    (threadFilterUserIds.length > 0 ? 1 : 0) +
    (threadFilterStatus !== "all" ? 1 : 0);

  const memberOptions = getOrgMembers(membersData).map((m) => {
    const label = m.user.name ?? m.user.email ?? m.userId;
    const url = m.user.image ?? undefined;
    return {
      value: m.userId,
      label,
      icon: ({ className }: { className?: string }) => (
        <Avatar
          url={url}
          fallback={label}
          shape="circle"
          size="2xs"
          className={cn("shrink-0", className)}
        />
      ),
    };
  });

  const baseParams = {
    startDate: dateRange.startDate.toISOString(),
    endDate: dateRange.endDate.toISOString(),
    connectionId: connectionIds.length === 1 ? connectionIds[0] : undefined,
    excludeConnectionIds,
    virtualMcpId: virtualMcpIds.length === 1 ? virtualMcpIds[0] : undefined,
    toolName: tool || undefined,
    isError:
      status === "errors" ? true : status === "success" ? false : undefined,
    ...propertyApiParams,
  };

  const tabs = [
    { id: "overview" as const, label: "Overview" },
    { id: "audit" as const, label: "Audit" },
    { id: "threads" as const, label: "Threads" },
  ];

  return (
    <>
      <Page.Body className="!pb-4">
        <div className="flex flex-col gap-5">
          <Page.Title>Monitoring</Page.Title>
          <div className="flex items-center justify-between gap-4">
            <CollectionTabs
              tabs={tabs}
              activeTab={tab}
              onTabChange={(tabId) =>
                onTabChange(tabId as "overview" | "audit" | "threads")
              }
            />
            <div className="flex items-center gap-2">
              {tab !== "threads" && (
                <>
                  <Button
                    variant={isStreaming ? "secondary" : "outline"}
                    className="gap-1.5"
                    onClick={onStreamingToggle}
                  >
                    {isStreaming && (
                      <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
                    )}
                    <span>Live</span>
                    {isStreaming && (
                      <span className="text-muted-foreground text-xs">3s</span>
                    )}
                  </Button>

                  <FiltersPopover
                    connectionIds={connectionIds}
                    virtualMcpIds={virtualMcpIds}
                    tool={tool}
                    status={status}
                    hideSystem={hideSystem}
                    propertyFilters={propertyFilters}
                    connectionOptions={connectionOptions}
                    virtualMcpOptions={virtualMcpOptions}
                    activeFiltersCount={activeFiltersCount}
                    onUpdateFilters={onUpdateFilters}
                    connectionSearchTerm={connectionSearch}
                    onConnectionSearchChange={setConnectionSearch}
                  />
                </>
              )}

              {tab === "threads" && (
                <ThreadsFiltersPopover
                  filterAgentIds={threadFilterAgentIds}
                  filterUserIds={threadFilterUserIds}
                  filterStatus={threadFilterStatus}
                  virtualMcpOptions={virtualMcpOptions}
                  memberOptions={memberOptions}
                  activeFiltersCount={threadActiveFiltersCount}
                  onUpdateFilters={({
                    filterAgentIds,
                    filterUserIds,
                    filterStatus,
                  }) => {
                    if (filterAgentIds !== undefined)
                      setThreadFilterAgentIds(filterAgentIds);
                    if (filterUserIds !== undefined)
                      setThreadFilterUserIds(filterUserIds);
                    if (filterStatus !== undefined)
                      setThreadFilterStatus(filterStatus);
                  }}
                />
              )}

              <TimeRangePicker
                value={{ from, to }}
                onChange={onTimeRangeChange}
              />
            </div>
          </div>
          {(tab === "audit" || tab === "threads") && (
            <SearchInput
              value={searchQuery}
              onChange={(value) => onUpdateFilters({ search: value })}
              placeholder={
                tab === "threads"
                  ? "Search by title\u2026"
                  : "Search by tool name, connection, or error..."
              }
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  onUpdateFilters({ search: "" });
                  (event.target as HTMLInputElement).blur();
                }
              }}
              className="w-full md:w-[375px]"
            />
          )}
        </div>
      </Page.Body>

      {tab === "threads" ? (
        <ThreadsTabContent
          client={client}
          locator={locator}
          membersData={membersData}
          allConnections={allConnections}
          allVirtualMcps={allVirtualMcps}
          dateRange={dateRange}
          searchQuery={searchQuery}
          filterAgentIds={threadFilterAgentIds}
          filterUserIds={threadFilterUserIds}
          filterStatus={threadFilterStatus}
        />
      ) : tab === "audit" ? (
        <AuditTabContent
          client={client}
          locator={locator}
          baseParams={baseParams}
          pageSize={pageSize}
          isStreaming={isStreaming}
          streamingRefetchInterval={streamingRefetchInterval}
          connectionIds={connectionIds}
          virtualMcpIds={virtualMcpIds}
          tool={tool}
          status={status}
          searchQuery={searchQuery}
          allConnections={allConnections}
          allVirtualMcps={allVirtualMcps}
          membersData={membersData}
        />
      ) : (
        <div className="flex-1 flex flex-col overflow-auto min-w-0">
          <OverviewTabContent
            displayDateRange={displayDateRange}
            connectionIds={connectionIds}
            excludeConnectionIds={excludeConnectionIds}
            toolName={tool || undefined}
            status={
              status === "errors"
                ? "error"
                : status === "success"
                  ? "success"
                  : undefined
            }
            connections={allConnections}
            isStreaming={isStreaming}
            streamingRefetchInterval={streamingRefetchInterval}
          />
        </div>
      )}
    </>
  );
}

// ============================================================================
// Route Entry Point
// ============================================================================

export default function MonitoringDashboard() {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const search = useSearch({
    from: "/shell/$org/settings/monitor",
  });

  const {
    tab = "overview",
    from,
    to,
    connectionId: connectionIds = [],
    virtualMcpId: virtualMcpIds = [],
    tool,
    search: searchQuery,
    status,
    streaming = true,
    propertyFilters: propertyFiltersStr = "",
    hideSystem = false,
  } = search;

  const propertyFilters = deserializePropertyFilters(propertyFiltersStr);

  const updateFilters = (updates: Partial<MonitoringSearchParams>) => {
    navigate({
      to: "/$org/settings/monitor",
      params: { org: org.slug },
      search: {
        ...search,
        ...updates,
      },
    });
  };

  const handleTimeRangeChange = (range: TimeRangeValue) => {
    updateFilters({ from: range.from, to: range.to });
  };

  const fromResult = expressionToDate(from);
  const toResult = expressionToDate(to);

  const startDate = fromResult.date || new Date(Date.now() - 30 * 60 * 1000);
  const originalEndDate = toResult.date || new Date();

  const displayDateRange = { startDate, endDate: originalEndDate };

  let fetchEndDate = originalEndDate;
  if (streaming && to === "now") {
    fetchEndDate = new Date(originalEndDate);
    fetchEndDate.setHours(fetchEndDate.getHours() + 1);
  }
  const dateRange = { startDate, endDate: fetchEndDate };

  let activeFiltersCount = 0;
  if (connectionIds.length > 0) activeFiltersCount++;
  if (virtualMcpIds.length > 0) activeFiltersCount++;
  if (tool) activeFiltersCount++;
  if (status !== "all") activeFiltersCount++;
  if (hideSystem) activeFiltersCount++;
  const validPropertyFilters = propertyFilters.filter((f) => f.key.trim());
  if (validPropertyFilters.length > 0)
    activeFiltersCount += validPropertyFilters.length;

  return (
    <Page>
      <ErrorBoundary
        fallback={
          <>
            <Page.Body className="!pb-3">
              <Page.Title>Monitoring</Page.Title>
            </Page.Body>
            <Page.Content>
              <div className="flex-1 flex items-center justify-center h-full">
                <EmptyState
                  title="Failed to load monitoring data"
                  description="There was an error loading the monitoring data. Please try again."
                />
              </div>
            </Page.Content>
          </>
        }
      >
        <Suspense
          fallback={
            <>
              <Page.Body className="!pb-3">
                <div className="flex flex-col gap-4">
                  <Page.Title>Monitoring</Page.Title>
                  <CollectionTabs
                    tabs={[
                      { id: "overview", label: "Overview" },
                      { id: "audit", label: "Audit" },
                      { id: "threads", label: "Threads" },
                    ]}
                    activeTab={tab}
                    onTabChange={(tabId) =>
                      updateFilters({
                        tab: tabId as "overview" | "audit" | "threads",
                      })
                    }
                  />
                </div>
              </Page.Body>

              {tab === "threads" ? (
                <div className="flex-1 flex flex-col overflow-auto md:overflow-hidden">
                  <MonitoringLogsTable.Skeleton />
                </div>
              ) : tab === "audit" ? (
                <div className="flex-1 flex flex-col overflow-auto md:overflow-hidden">
                  <MonitoringLogsTable.Skeleton />
                </div>
              ) : (
                <div className="flex-1 flex flex-col overflow-auto">
                  <OverviewTabSkeleton />
                </div>
              )}
            </>
          }
        >
          <MonitoringDashboardContent
            tab={tab}
            dateRange={dateRange}
            displayDateRange={displayDateRange}
            connectionIds={connectionIds}
            virtualMcpIds={virtualMcpIds}
            tool={tool}
            status={status}
            search={searchQuery}
            streaming={streaming}
            hideSystem={hideSystem}
            activeFiltersCount={activeFiltersCount}
            from={from}
            to={to}
            propertyFilters={propertyFilters}
            onUpdateFilters={updateFilters}
            onTimeRangeChange={(range) => {
              track("monitoring_time_range_changed", {
                from: range.from,
                to: range.to,
              });
              handleTimeRangeChange(range);
            }}
            onStreamingToggle={() => {
              track("monitoring_live_toggled", { enabled: !streaming });
              updateFilters({ streaming: !streaming });
            }}
            onTabChange={(newTab) => {
              if (newTab !== tab) {
                track("monitoring_tab_changed", {
                  from_tab: tab,
                  to_tab: newTab,
                });
              }
              updateFilters({ tab: newTab });
            }}
          />
        </Suspense>
      </ErrorBoundary>
    </Page>
  );
}
