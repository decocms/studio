/**
 * Dashboard View Component
 *
 * Displays a single dashboard with its widgets and aggregated data.
 */

import { KEYS } from "@/web/lib/query-keys";
import {
  useMCPClient,
  useProjectContext,
  SELF_MCP_ALIAS_ID,
} from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import {
  TimeRangePicker,
  type TimeRange as TimeRangeValue,
} from "@deco/ui/components/time-range-picker.tsx";
import { expressionToDate } from "@deco/ui/lib/time-expressions.ts";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import { RefreshCw01, Edit05 } from "@untitledui/icons";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { useQueryClient } from "@tanstack/react-query";
import { ViewLayout, ViewActions } from "@/web/components/details/layout";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@deco/ui/components/breadcrumb.tsx";
import { Link } from "@tanstack/react-router";
import { PropertyFilterPopover } from "./property-filter-popover";
import type { PropertyFilter } from "./types";
import { propertyFiltersToApiParams, serializePropertyFilters } from "./types";

// ============================================================================
// Types
// ============================================================================

interface Widget {
  id: string;
  name: string;
  type: "metric" | "timeseries" | "table";
  source: {
    path: string;
    from: "input" | "output";
  };
  aggregation: {
    fn: string;
    groupBy?: string;
    interval?: string;
  };
}

interface Dashboard {
  id: string;
  name: string;
  description: string | null;
  widgets: Widget[];
}

interface WidgetResult {
  widgetId: string;
  value: number | null;
  groups?: Array<{ key: string; value: number }>;
  timeseries?: Array<{ timestamp: string; value: number }>;
}

interface QueryResponse {
  dashboardId: string;
  results: WidgetResult[];
  timeRange: {
    startDate: string;
    endDate: string;
  };
}

// ============================================================================
// Widget Components
// ============================================================================

function formatNumber(value: number, isCount: boolean): string {
  if (isCount || Number.isInteger(value)) {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
    return value.toLocaleString();
  }
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toFixed(2);
}

function aggLabel(fn: string): string {
  const labels: Record<string, string> = {
    sum: "Total",
    avg: "Average",
    min: "Minimum",
    max: "Maximum",
    count: "Count",
    last: "Latest",
  };
  return labels[fn] ?? fn;
}

// Shared card header for all widget types
function WidgetHeader({ name, subtitle }: { name: string; subtitle: string }) {
  return (
    <div className="px-4 py-3">
      <div className="text-sm font-medium text-foreground">{name}</div>
      <div className="text-xs text-muted-foreground">{subtitle}</div>
    </div>
  );
}

function MetricWidget({
  widget,
  result,
}: {
  widget: Widget;
  result: WidgetResult | undefined;
}) {
  const value = result?.value ?? 0;
  const isCount = widget.aggregation.fn === "count";

  return (
    <div className="border rounded-lg bg-card flex flex-col h-full">
      <WidgetHeader
        name={widget.name}
        subtitle={aggLabel(widget.aggregation.fn)}
      />
      <div className="px-4 pb-4 mt-auto">
        <div className="text-4xl font-bold tabular-nums">
          {formatNumber(value, isCount)}
        </div>
      </div>
    </div>
  );
}

function TableWidget({
  widget,
  result,
}: {
  widget: Widget;
  result: WidgetResult | undefined;
}) {
  const groups = result?.groups ?? [];
  const maxGroupValue = Math.max(...groups.map((g) => g.value), 1);

  return (
    <div className="border rounded-lg bg-card overflow-hidden flex flex-col h-full">
      <WidgetHeader
        name={widget.name}
        subtitle={
          widget.aggregation.groupBy
            ? `Grouped by ${widget.aggregation.groupBy}`
            : aggLabel(widget.aggregation.fn)
        }
      />
      <div className="max-h-[300px] overflow-auto">
        {groups.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No data available for this query
          </div>
        ) : (
          <div className="divide-y">
            {groups.map((group) => (
              <div
                key={group.key}
                className="flex items-center gap-3 px-4 py-2"
              >
                <span className="text-sm truncate flex-1 min-w-0">
                  {group.key || "(empty)"}
                </span>
                <div className="flex items-center gap-2 shrink-0 w-32">
                  <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full"
                      style={{
                        width: `${(group.value / maxGroupValue) * 100}%`,
                      }}
                    />
                  </div>
                  <span className="text-xs tabular-nums text-muted-foreground w-10 text-right">
                    {formatNumber(group.value, true)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TimeseriesWidget({
  widget,
  result,
}: {
  widget: Widget;
  result: WidgetResult | undefined;
}) {
  const timeseries = result?.timeseries ?? [];
  const maxValue = Math.max(...timeseries.map((t) => t.value), 1);
  const total = timeseries.reduce((sum, t) => sum + t.value, 0);
  const isCount = widget.aggregation.fn === "count";

  return (
    <div className="border rounded-lg bg-card overflow-hidden flex flex-col h-full">
      <div className="flex items-start justify-between pr-4">
        <WidgetHeader
          name={widget.name}
          subtitle={`${aggLabel(widget.aggregation.fn)} per ${widget.aggregation.interval}`}
        />
        <div className="text-right pt-3">
          <div className="text-lg font-semibold tabular-nums leading-tight">
            {formatNumber(total, isCount)}
          </div>
          <div className="text-xs text-muted-foreground">total</div>
        </div>
      </div>
      <div className="px-4 pb-3 flex-1 flex flex-col min-h-0">
        {timeseries.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            No data available
          </div>
        ) : (
          <div className="flex-1 flex flex-col">
            {/* Y-axis max label */}
            <div className="text-[10px] text-muted-foreground mb-1 tabular-nums">
              {formatNumber(maxValue, isCount)}
            </div>
            {/* Bars — fills remaining space */}
            <div className="flex items-end gap-[2px] flex-1">
              {timeseries.map((point, i) => (
                <div
                  key={i}
                  className="group relative flex-1 bg-primary/70 rounded-t transition-all hover:bg-primary cursor-default"
                  style={{
                    height: `${(point.value / maxValue) * 100}%`,
                    minHeight: point.value > 0 ? "3px" : "0px",
                  }}
                >
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 hidden group-hover:block z-10 pointer-events-none">
                    <div className="bg-foreground text-background text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap tabular-nums">
                      {formatNumber(point.value, isCount)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {/* X-axis labels */}
            <div className="flex justify-between text-[10px] text-muted-foreground mt-1.5 tabular-nums">
              {timeseries.length > 0 &&
                (() => {
                  const first = new Date(timeseries[0]!.timestamp);
                  const last = new Date(
                    timeseries[timeseries.length - 1]!.timestamp,
                  );
                  const rangeMs = last.getTime() - first.getTime();
                  const isMultiDay = rangeMs > 24 * 60 * 60 * 1000;
                  const fmt = isMultiDay
                    ? ({ month: "short", day: "numeric" } as const)
                    : ({
                        hour: "2-digit",
                        minute: "2-digit",
                      } as const);
                  return (
                    <>
                      <span>{first.toLocaleString([], fmt)}</span>
                      <span>{last.toLocaleString([], fmt)}</span>
                    </>
                  );
                })()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Dashboard View Content
// ============================================================================

interface DashboardViewContentProps {
  dashboardId: string;
  timeRange: { from: string; to: string };
  propertyFilters: PropertyFilter[];
  onEdit?: () => void;
  onRefresh: () => void;
  onTimeRangeChange: (range: TimeRangeValue) => void;
  onPropertyFiltersChange: (filters: PropertyFilter[]) => void;
}

function DashboardViewContent({
  dashboardId,
  timeRange,
  propertyFilters,
  onEdit,
  onRefresh,
  onTimeRangeChange,
  onPropertyFiltersChange,
}: DashboardViewContentProps) {
  const { org, locator } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  // Fetch dashboard details
  const { data: dashboard } = useSuspenseQuery({
    queryKey: KEYS.monitoringDashboardDetails(locator, dashboardId),
    queryFn: async () => {
      if (!client) throw new Error("MCP client not available");
      const result = (await client.callTool({
        name: "MONITORING_DASHBOARD_GET",
        arguments: { id: dashboardId },
      })) as { structuredContent?: Dashboard };
      return (result.structuredContent ?? result) as Dashboard | null;
    },
  });

  // Fetch query results
  // IMPORTANT: Use expression strings in the key (not computed dates) to avoid
  // infinite re-fetching when expressions like "now" are used
  const activeFilters = propertyFilters.filter((f) => f.key.trim());
  const serializedFilters = serializePropertyFilters(activeFilters);
  const apiPropertyFilters =
    activeFilters.length > 0
      ? propertyFiltersToApiParams(activeFilters)
      : undefined;

  const { data: queryData, isRefetching } = useSuspenseQuery({
    queryKey: KEYS.monitoringDashboardQuery(
      locator,
      dashboardId,
      timeRange.from,
      timeRange.to,
      serializedFilters || undefined,
    ),
    queryFn: async () => {
      if (!client) throw new Error("MCP client not available");

      // Parse time range inside queryFn (not during render)
      const fromResult = expressionToDate(timeRange.from);
      const toResult = expressionToDate(timeRange.to);
      const startDate =
        fromResult.date || new Date(Date.now() - 24 * 60 * 60 * 1000);
      const endDate = toResult.date || new Date();

      const result = (await client.callTool({
        name: "MONITORING_DASHBOARD_QUERY",
        arguments: {
          dashboardId,
          timeRange: {
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
          },
          ...(apiPropertyFilters
            ? { propertyFilters: apiPropertyFilters }
            : {}),
        },
      })) as { structuredContent?: QueryResponse };
      return (result.structuredContent ?? result) as QueryResponse;
    },
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  if (!dashboard) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        Dashboard not found
      </div>
    );
  }

  // Create a map of widget results
  const resultsMap = new Map(
    queryData?.results?.map((r) => [r.widgetId, r]) ?? [],
  );

  // Breadcrumb
  const breadcrumb = (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link
              to="/$org/monitoring"
              params={{ org: org.slug }}
              search={{ tab: "dashboards" }}
            >
              Monitoring
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>{dashboard.name}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );

  return (
    <ViewLayout breadcrumb={breadcrumb}>
      <ViewActions>
        {onEdit && (
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            onClick={onEdit}
          >
            <Edit05 size={14} />
          </Button>
        )}
        <Button
          variant="outline"
          size="icon"
          className="h-7 w-7"
          onClick={onRefresh}
        >
          <RefreshCw01 size={14} />
        </Button>
        <PropertyFilterPopover
          value={propertyFilters}
          onChange={onPropertyFiltersChange}
        />
        <TimeRangePicker
          value={{ from: timeRange.from, to: timeRange.to }}
          onChange={onTimeRangeChange}
          className="min-w-0"
        />
      </ViewActions>

      <div className="flex-1 flex flex-col overflow-auto p-5">
        {/* Dashboard Header */}
        {dashboard.description && (
          <div className="mb-6">
            <p className="text-sm text-muted-foreground">
              {dashboard.description}
            </p>
          </div>
        )}

        {/* Widgets Bento Grid — row height matches 1-col width for square metrics */}
        <div
          className="grid grid-cols-2 lg:grid-cols-5 gap-4"
          ref={(el) => {
            if (!el) return;
            const update = () => {
              const gap = 16; // gap-4
              const cols = window.innerWidth >= 1024 ? 5 : 2;
              const colW = (el.clientWidth - gap * (cols - 1)) / cols;
              el.style.gridAutoRows = `${colW}px`;
            };
            update();
            const observer = new ResizeObserver(update);
            observer.observe(el);
            window.addEventListener("resize", update);
            return () => {
              observer.disconnect();
              window.removeEventListener("resize", update);
            };
          }}
        >
          {dashboard.widgets.map((widget) => {
            const result = resultsMap.get(widget.id);
            const spanClass = widget.type === "metric" ? "" : "col-span-2";

            return (
              <div key={widget.id} className={spanClass}>
                {widget.type === "metric" && (
                  <MetricWidget widget={widget} result={result} />
                )}
                {widget.type === "table" && (
                  <TableWidget widget={widget} result={result} />
                )}
                {widget.type === "timeseries" && (
                  <TimeseriesWidget widget={widget} result={result} />
                )}
              </div>
            );
          })}
        </div>

        {/* Loading overlay during refresh */}
        {isRefetching && (
          <div className="fixed bottom-4 right-4 bg-background border rounded-lg px-3 py-2 shadow-lg flex items-center gap-2 text-sm">
            <RefreshCw01 size={14} className="animate-spin" />
            Refreshing...
          </div>
        )}
      </div>
    </ViewLayout>
  );
}

// ============================================================================
// Main Export
// ============================================================================

export interface DashboardViewPageProps {
  dashboardId: string;
  onEdit?: () => void;
}

export function DashboardViewPage({
  dashboardId,
  onEdit,
}: DashboardViewPageProps) {
  const queryClient = useQueryClient();
  const [timeRange, setTimeRange] = useState<TimeRangeValue>({
    from: "now-24h",
    to: "now",
  });
  const [propertyFilters, setPropertyFilters] = useState<PropertyFilter[]>([]);

  const handleRefresh = () => {
    queryClient.invalidateQueries({
      predicate: (query) =>
        query.queryKey[0] === "monitoringDashboardQuery" &&
        query.queryKey[2] === dashboardId,
    });
  };

  return (
    <ErrorBoundary
      fallback={
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          Failed to load dashboard
        </div>
      }
    >
      <Suspense
        fallback={
          <div className="flex-1 flex items-center justify-center">
            <RefreshCw01
              size={24}
              className="animate-spin text-muted-foreground"
            />
          </div>
        }
      >
        <DashboardViewContent
          dashboardId={dashboardId}
          timeRange={timeRange}
          propertyFilters={propertyFilters}
          onEdit={onEdit}
          onRefresh={handleRefresh}
          onTimeRangeChange={setTimeRange}
          onPropertyFiltersChange={setPropertyFilters}
        />
      </Suspense>
    </ErrorBoundary>
  );
}
