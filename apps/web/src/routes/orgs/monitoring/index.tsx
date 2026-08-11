/**
 * Monitoring Dashboard Route
 *
 * Tab switcher + shared state. Delegates to overview, audit, and threads tabs.
 */

import { SearchInput } from "@decocms/ui/components/search-input.tsx";
import { Page } from "@/components/page";
import { EmptyState } from "@/components/empty-state.tsx";
import { ErrorBoundary } from "@/components/error-boundary";
import { RequireCapability } from "@/components/require-capability";
import { MONITORING_CONFIG } from "@/components/monitoring/config.ts";
import type { DateRange } from "@/components/monitoring/monitoring-stats-row.tsx";
import {
  type MonitoringSearchParams,
  type PropertyFilter,
  type PropertyFilterOperator,
  deserializePropertyFilters,
  serializePropertyFilters,
  propertyFiltersToApiParams,
  propertyFiltersToRaw,
  parseRawPropertyFilters,
} from "@/components/monitoring";
import { useMembers } from "@/hooks/use-members";
import {
  SELF_MCP_ALIAS_ID,
  WellKnownOrgMCPId,
  useConnections,
  useMCPClient,
  useProjectContext,
  useVirtualMCPs,
} from "@/sdk";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { FilterLines, Container } from "@untitledui/icons";
import { Input } from "@decocms/ui/components/input.tsx";
import { MultiSelect } from "@decocms/ui/components/multi-select.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import {
  TimeRangePicker,
  type TimeRange as TimeRangeValue,
} from "@decocms/ui/components/time-range-picker.tsx";
import { expressionToDate } from "@decocms/ui/lib/time-expressions.ts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Suspense, useRef, useState } from "react";
import { Plus, Trash01, Code01, Grid01 } from "@untitledui/icons";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { CollectionTabs } from "@/components/collections/collection-tabs.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { IntegrationIcon } from "@/components/integration-icon.tsx";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { useT } from "@/i18n/use-t";

import { OverviewTabContent, OverviewTabSkeleton } from "./overview.tsx";
import { AuditTabContent, MonitoringLogsTable } from "./audit.tsx";
import { ThreadsTabContent } from "./threads.tsx";
import { ThreadsFiltersPopover } from "./threads-filters-popover.tsx";
import { AutomationsTabContent } from "./automations.tsx";
import { getOrgMembers } from "./utils.ts";
import { track } from "@/lib/posthog-client";

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
  /** Member options + AI-usage member filter (overview tab only). */
  memberOptions?: Array<{ value: string; label: string }>;
  llmUserIds?: string[];
  onLlmUserIdsChange?: (values: string[]) => void;
  showMemberFilter?: boolean;
}

interface OperatorOption {
  value: PropertyFilterOperator;
  labelKey:
    | "orgs.monitoring.operatorEquals"
    | "orgs.monitoring.operatorContains"
    | "orgs.monitoring.operatorIn"
    | "orgs.monitoring.operatorExists";
}

const OPERATOR_OPTIONS: OperatorOption[] = [
  { value: "eq", labelKey: "orgs.monitoring.operatorEquals" },
  { value: "contains", labelKey: "orgs.monitoring.operatorContains" },
  { value: "in", labelKey: "orgs.monitoring.operatorIn" },
  { value: "exists", labelKey: "orgs.monitoring.operatorExists" },
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
  memberOptions,
  llmUserIds = [],
  onLlmUserIdsChange,
  showMemberFilter,
}: FiltersPopoverProps) {
  const t = useT();
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

  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  if (prevToolRef.current !== tool) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    prevToolRef.current = tool;
    if (localTool !== tool) {
      setLocalTool(tool);
    }
  }

  const currentSerialized = serializePropertyFilters(propertyFilters);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  if (prevPropertyFiltersRef.current !== currentSerialized) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
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
          <span className="hidden sm:inline">
            {t("orgs.monitoring.filters")}
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
      <PopoverContent align="end" className="w-[320px]">
        <div className="space-y-4">
          <div>
            <h4 className="font-medium text-sm mb-3">
              {t("orgs.monitoring.filterLogs")}
            </h4>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label
                htmlFor="hide-system-calls"
                className="text-xs font-medium text-muted-foreground cursor-pointer"
              >
                {t("orgs.monitoring.hideSystemCalls")}
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
                {t("orgs.monitoring.connections")}
              </label>
              <MultiSelect
                options={connectionOptions}
                defaultValue={connectionIds}
                onValueChange={(values) =>
                  onUpdateFilters({ connectionId: values })
                }
                onSearchChange={onConnectionSearchChange}
                placeholder={t("orgs.monitoring.allServers")}
                variant="secondary"
                className="w-full"
                maxCount={2}
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                {t("orgs.monitoring.agents")}
              </label>
              <MultiSelect
                options={virtualMcpOptions}
                defaultValue={virtualMcpIds}
                onValueChange={(values) =>
                  onUpdateFilters({ virtualMcpId: values })
                }
                placeholder={t("orgs.monitoring.allAgents")}
                variant="secondary"
                className="w-full"
                maxCount={2}
              />
            </div>

            {showMemberFilter && (
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                  {t("orgs.monitoring.members")}
                </label>
                <MultiSelect
                  options={memberOptions ?? []}
                  defaultValue={llmUserIds}
                  onValueChange={(values) => onLlmUserIdsChange?.(values)}
                  placeholder={t("orgs.monitoring.allMembers")}
                  variant="secondary"
                  className="w-full"
                  maxCount={2}
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  {t("orgs.monitoring.filtersAiUsageOnly")}
                </p>
              </div>
            )}

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                {t("orgs.monitoring.toolName")}
              </label>
              <Input
                id="filter-tool"
                placeholder={t("orgs.monitoring.filterByToolPlaceholder")}
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
                {t("orgs.monitoring.status")}
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
                  <SelectItem value="all">
                    {t("orgs.monitoring.allStatus")}
                  </SelectItem>
                  <SelectItem value="success">
                    {t("orgs.monitoring.successOnly")}
                  </SelectItem>
                  <SelectItem value="errors">
                    {t("orgs.monitoring.errorsOnly")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-medium text-muted-foreground">
                  {t("orgs.monitoring.propertyFilters")}
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
                      ? t("orgs.monitoring.switchToFormView")
                      : t("orgs.monitoring.switchToRawText")}
                  </TooltipContent>
                </Tooltip>
              </div>

              {propertyFilterMode === "raw" ? (
                <div className="space-y-1.5">
                  <Textarea
                    placeholder={t(
                      "orgs.monitoring.pastePropertyFiltersPlaceholder",
                    )}
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
                    {t("orgs.monitoring.onePerLine")}{" "}
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
                          {t("orgs.monitoring.filter", {
                            number: (index + 1).toString(),
                          })}
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
                          placeholder={t("orgs.monitoring.keyPlaceholder")}
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
                                {t(op.labelKey)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {filter.operator !== "exists" && (
                        <Input
                          placeholder={t("orgs.monitoring.valuePlaceholder")}
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
                    {t("orgs.monitoring.addFilter")}
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
              {t("orgs.monitoring.clearAllFilters")}
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
  // Mirror the route's tab union (includes "dashboards"); unknown tabs fall
  // through to the overview branch below.
  tab: NonNullable<MonitoringSearchParams["tab"]>;
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
  onTabChange: (tab: "overview" | "audit" | "threads" | "automations") => void;
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
  const t = useT();
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
    const name = vm.title ?? "Super Agent";
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

  // AI-usage member filter (overview tab only; local state like thread filters)
  const [llmUserIds, setLlmUserIds] = useState<string[]>([]);

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
    { id: "overview" as const, label: t("orgs.monitoring.overview") },
    { id: "audit" as const, label: t("orgs.monitoring.audit") },
    { id: "threads" as const, label: t("orgs.monitoring.chats") },
    { id: "automations" as const, label: t("orgs.monitoring.automations") },
  ];

  return (
    <>
      <Page.Body className="!pb-4">
        <div className="flex flex-col gap-5">
          <Page.Title>{t("orgs.monitoring.title")}</Page.Title>
          <div className="flex items-center justify-between gap-4">
            <CollectionTabs
              tabs={tabs}
              activeTab={tab}
              onTabChange={(tabId) =>
                onTabChange(
                  tabId as "overview" | "audit" | "threads" | "automations",
                )
              }
            />
            <div className="flex items-center gap-2">
              {(tab === "overview" || tab === "audit") && (
                <>
                  <Button
                    variant={isStreaming ? "secondary" : "outline"}
                    className="gap-1.5"
                    onClick={onStreamingToggle}
                  >
                    {isStreaming && (
                      <span className="size-2 rounded-full bg-success animate-pulse" />
                    )}
                    <span>{t("orgs.monitoring.live")}</span>
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
                    memberOptions={memberOptions}
                    llmUserIds={llmUserIds}
                    onLlmUserIdsChange={setLlmUserIds}
                    showMemberFilter={tab === "overview"}
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
                labels={{
                  absoluteTimeRange: t(
                    "monitoring.timeRangePicker.absoluteTimeRange",
                  ),
                  from: t("monitoring.timeRangePicker.from"),
                  to: t("monitoring.timeRangePicker.to"),
                  applyTimeRange: t(
                    "monitoring.timeRangePicker.applyTimeRange",
                  ),
                }}
                quickRanges={[
                  {
                    label: t("monitoring.timeRangePicker.last5Minutes"),
                    from: "now-5m",
                    to: "now",
                    value: "5m",
                  },
                  {
                    label: t("monitoring.timeRangePicker.last15Minutes"),
                    from: "now-15m",
                    to: "now",
                    value: "15m",
                  },
                  {
                    label: t("monitoring.timeRangePicker.last30Minutes"),
                    from: "now-30m",
                    to: "now",
                    value: "30m",
                  },
                  {
                    label: t("monitoring.timeRangePicker.last1Hour"),
                    from: "now-1h",
                    to: "now",
                    value: "1h",
                  },
                  {
                    label: t("monitoring.timeRangePicker.last3Hours"),
                    from: "now-3h",
                    to: "now",
                    value: "3h",
                  },
                  {
                    label: t("monitoring.timeRangePicker.last6Hours"),
                    from: "now-6h",
                    to: "now",
                    value: "6h",
                  },
                  {
                    label: t("monitoring.timeRangePicker.last12Hours"),
                    from: "now-12h",
                    to: "now",
                    value: "12h",
                  },
                  {
                    label: t("monitoring.timeRangePicker.last24Hours"),
                    from: "now-24h",
                    to: "now",
                    value: "24h",
                  },
                  {
                    label: t("monitoring.timeRangePicker.last2Days"),
                    from: "now-2d",
                    to: "now",
                    value: "2d",
                  },
                  {
                    label: t("monitoring.timeRangePicker.last7Days"),
                    from: "now-7d",
                    to: "now",
                    value: "7d",
                  },
                  {
                    label: t("monitoring.timeRangePicker.last30Days"),
                    from: "now-30d",
                    to: "now",
                    value: "30d",
                  },
                ]}
              />
            </div>
          </div>
          {(tab === "audit" || tab === "threads") && (
            <SearchInput
              value={searchQuery}
              onChange={(value) => onUpdateFilters({ search: value })}
              placeholder={
                tab === "threads"
                  ? t("orgs.monitoring.searchByTitlePlaceholder")
                  : t("orgs.monitoring.searchByToolPlaceholder")
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

      {tab === "automations" ? (
        <AutomationsTabContent dateRange={dateRange} />
      ) : tab === "threads" ? (
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
            llmUserIds={llmUserIds}
            virtualMcpIds={virtualMcpIds}
            virtualMcps={allVirtualMcps}
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
  const t = useT();
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
    <RequireCapability capability="monitoring:view" area="monitoring">
      <Page>
        <ErrorBoundary
          fallback={
            <>
              <Page.Body className="!pb-3">
                <Page.Title>{t("orgs.monitoring.title")}</Page.Title>
              </Page.Body>
              <Page.Content>
                <div className="flex-1 flex items-center justify-center h-full">
                  <EmptyState
                    title={t("orgs.monitoring.failedLoadTitle")}
                    description={t("orgs.monitoring.failedLoadDescription")}
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
                    <Page.Title>{t("orgs.monitoring.title")}</Page.Title>
                    <CollectionTabs
                      tabs={[
                        {
                          id: "overview",
                          label: t("orgs.monitoring.overview"),
                        },
                        { id: "audit", label: t("orgs.monitoring.audit") },
                        { id: "threads", label: t("orgs.monitoring.chats") },
                        {
                          id: "automations",
                          label: t("orgs.monitoring.automations"),
                        },
                      ]}
                      activeTab={tab}
                      onTabChange={(tabId) =>
                        updateFilters({
                          tab: tabId as
                            | "overview"
                            | "audit"
                            | "threads"
                            | "automations",
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
    </RequireCapability>
  );
}
