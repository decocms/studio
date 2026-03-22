/**
 * Dashboard Edit Page
 *
 * Full-page editor for monitoring dashboards with query preview.
 */

import { ErrorBoundary } from "@/web/components/error-boundary";
import { KEYS } from "@/web/lib/query-keys";
import {
  useMCPClient,
  useProjectContext,
  useConnections,
  SELF_MCP_ALIAS_ID,
} from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { Checkbox } from "@deco/ui/components/checkbox.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { ChevronDown, ChevronUp } from "@untitledui/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import {
  Plus,
  Trash01,
  Play,
  RefreshCw01,
  Hash02,
  BarChartSquare02,
  AlignLeft,
} from "@untitledui/icons";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@deco/ui/components/toggle-group.tsx";
import { toast } from "sonner";
import { Link, useParams } from "@tanstack/react-router";
import { ViewLayout, ViewActions } from "@/web/components/details/layout";
import { SaveActions } from "@/web/components/save-actions";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@deco/ui/components/breadcrumb.tsx";

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

interface DashboardFilters {
  connectionIds?: string[];
  virtualMcpIds?: string[];
  toolNames?: string[];
}

interface Dashboard {
  id: string;
  name: string;
  description: string | null;
  filters: DashboardFilters | null;
  widgets: Widget[];
}

interface WidgetInput {
  id: string;
  name: string;
  type: "metric" | "timeseries" | "table";
  sourcePath: string;
  sourceFrom: "input" | "output";
  aggregationFn: "sum" | "avg" | "min" | "max" | "count" | "last";
  groupBy: string;
  interval: string;
}

interface PreviewResult {
  value?: number | null;
  groups?: Array<{ key: string; value: number }>;
  timeseries?: Array<{ timestamp: string; value: number }>;
  matchedRecords?: number;
  error?: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

function widgetToInput(widget: Widget): WidgetInput {
  return {
    id: widget.id,
    name: widget.name,
    type: widget.type,
    sourcePath: widget.source.path,
    sourceFrom: widget.source.from,
    aggregationFn: widget.aggregation.fn as WidgetInput["aggregationFn"],
    groupBy: widget.aggregation.groupBy || "",
    interval: widget.aggregation.interval || "",
  };
}

function inputToWidget(input: WidgetInput): Widget {
  return {
    id: input.id,
    name: input.name,
    type: input.type,
    source: {
      path: input.sourcePath,
      from: input.sourceFrom,
    },
    aggregation: {
      fn: input.aggregationFn,
      groupBy:
        input.type === "table" && input.groupBy ? input.groupBy : undefined,
      interval:
        input.type === "timeseries" && input.interval
          ? input.interval
          : undefined,
    },
  };
}

const DEFAULT_WIDGET: WidgetInput = {
  id: crypto.randomUUID(),
  name: "",
  type: "metric",
  sourcePath: "$.usage.total_tokens",
  sourceFrom: "output",
  aggregationFn: "sum",
  groupBy: "",
  interval: "",
};

// ============================================================================
// Preview Result Display
// ============================================================================

function PreviewResultDisplay({
  result,
  widget,
}: {
  result: PreviewResult;
  widget: WidgetInput;
}) {
  if (result.error) {
    return (
      <div className="text-sm text-destructive bg-destructive/10 rounded p-3">
        {result.error}
      </div>
    );
  }

  if (widget.type === "metric") {
    const value = result.value ?? 0;
    const formattedValue =
      value >= 1000000
        ? `${(value / 1000000).toFixed(2)}M`
        : value >= 1000
          ? `${(value / 1000).toFixed(2)}K`
          : typeof value === "number"
            ? value.toFixed(2)
            : String(value);

    return (
      <div className="text-center py-4">
        <div className="text-3xl font-bold tabular-nums">{formattedValue}</div>
        <div className="text-xs text-muted-foreground mt-1">
          {result.matchedRecords ?? 0} records matched
        </div>
      </div>
    );
  }

  if (widget.type === "table" && result.groups) {
    return (
      <div className="max-h-[200px] overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 sticky top-0">
            <tr>
              <th className="text-left px-3 py-1.5 text-xs font-medium">Key</th>
              <th className="text-right px-3 py-1.5 text-xs font-medium">
                Value
              </th>
            </tr>
          </thead>
          <tbody>
            {result.groups.length === 0 ? (
              <tr>
                <td
                  colSpan={2}
                  className="px-3 py-4 text-center text-muted-foreground text-xs"
                >
                  No data
                </td>
              </tr>
            ) : (
              result.groups.slice(0, 10).map((group, i) => (
                <tr key={i} className="border-t">
                  <td className="px-3 py-1.5 font-mono text-xs">{group.key}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-xs">
                    {group.value.toLocaleString()}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {result.groups.length > 10 && (
          <div className="text-xs text-muted-foreground text-center py-2">
            +{result.groups.length - 10} more rows
          </div>
        )}
      </div>
    );
  }

  if (widget.type === "timeseries" && result.timeseries) {
    const maxValue = Math.max(...result.timeseries.map((t) => t.value), 1);
    return (
      <div className="py-2">
        <div className="flex items-end gap-0.5 h-[80px]">
          {result.timeseries.slice(-24).map((point, i) => (
            <div
              key={i}
              className="flex-1 bg-primary/80 rounded-t"
              style={{
                height: `${(point.value / maxValue) * 100}%`,
                minHeight: point.value > 0 ? "2px" : "0px",
              }}
              title={`${new Date(point.timestamp).toLocaleString()}: ${point.value}`}
            />
          ))}
        </div>
        <div className="text-xs text-muted-foreground text-center mt-2">
          {result.timeseries.length} data points
        </div>
      </div>
    );
  }

  return (
    <div className="text-sm text-muted-foreground text-center py-4">
      No preview data
    </div>
  );
}

// ============================================================================
// Widget Editor with Preview
// ============================================================================

interface WidgetEditorProps {
  widget: WidgetInput;
  onChange: (widget: WidgetInput) => void;
  onRemove: () => void;
  canRemove: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onPreview: () => void;
  previewResult: PreviewResult | null;
  isPreviewing: boolean;
}

function WidgetEditor({
  widget,
  onChange,
  onRemove,
  canRemove,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  onPreview,
  previewResult,
  isPreviewing,
}: WidgetEditorProps) {
  return (
    <div className="border rounded-lg bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-11 border-b bg-muted/30">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onMoveUp}
              disabled={!canMoveUp}
            >
              <ChevronUp size={14} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onMoveDown}
              disabled={!canMoveDown}
            >
              <ChevronDown size={14} />
            </Button>
          </div>
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {widget.type}
          </span>
          {widget.name && (
            <>
              <span className="text-muted-foreground">·</span>
              <span className="text-sm font-medium">{widget.name}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onPreview}
            disabled={isPreviewing}
          >
            {isPreviewing ? (
              <RefreshCw01 size={14} className="animate-spin" />
            ) : (
              <Play size={14} />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onRemove}
            disabled={!canRemove}
            style={{ visibility: canRemove ? "visible" : "hidden" }}
          >
            <Trash01 size={14} />
          </Button>
        </div>
      </div>

      <div className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Left: Configuration */}
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium block mb-1.5">
                  Widget Name
                </label>
                <Input
                  placeholder="e.g., Total Tokens"
                  value={widget.name}
                  onChange={(e) =>
                    onChange({ ...widget, name: e.target.value })
                  }
                />
              </div>
              <div>
                <label className="text-sm font-medium block mb-1.5">Type</label>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  value={widget.type}
                  onValueChange={(value) => {
                    if (!value) return;
                    onChange({
                      ...widget,
                      type: value as WidgetInput["type"],
                      groupBy: value === "table" ? widget.groupBy : "",
                      interval:
                        value === "timeseries" ? widget.interval || "1h" : "",
                    });
                  }}
                  className="w-full h-10"
                >
                  <ToggleGroupItem
                    value="metric"
                    className="flex-1 h-full data-[state=on]:!bg-accent/70"
                    aria-label="Metric"
                  >
                    <Hash02 size={14} />
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="timeseries"
                    className="flex-1 h-full data-[state=on]:!bg-accent/70"
                    aria-label="Timeseries"
                  >
                    <BarChartSquare02 size={14} />
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="table"
                    className="flex-1 h-full data-[state=on]:!bg-accent/70"
                    aria-label="Table"
                  >
                    <AlignLeft size={14} />
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium block mb-1.5">
                JSONPath Expression
              </label>
              <Input
                placeholder="$.usage.total_tokens"
                value={widget.sourcePath}
                onChange={(e) =>
                  onChange({ ...widget, sourcePath: e.target.value })
                }
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Path to extract from tool call {widget.sourceFrom}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium block mb-1.5">
                  Extract From
                </label>
                <Select
                  value={widget.sourceFrom}
                  onValueChange={(value) =>
                    onChange({
                      ...widget,
                      sourceFrom: value as "input" | "output",
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="output">Output</SelectItem>
                    <SelectItem value="input">Input</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium block mb-1.5">
                  Aggregation
                </label>
                <Select
                  value={widget.aggregationFn}
                  onValueChange={(value) =>
                    onChange({
                      ...widget,
                      aggregationFn: value as WidgetInput["aggregationFn"],
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sum">Sum</SelectItem>
                    <SelectItem value="avg">Average</SelectItem>
                    <SelectItem value="min">Minimum</SelectItem>
                    <SelectItem value="max">Maximum</SelectItem>
                    <SelectItem value="count">Count</SelectItem>
                    <SelectItem value="last">Last</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {widget.type === "table" && (
              <div>
                <label className="text-sm font-medium block mb-1.5">
                  Group By (JSONPath)
                </label>
                <Input
                  placeholder="$.model"
                  value={widget.groupBy}
                  onChange={(e) =>
                    onChange({ ...widget, groupBy: e.target.value })
                  }
                  className="font-mono text-sm"
                />
              </div>
            )}

            {widget.type === "timeseries" && (
              <div>
                <label className="text-sm font-medium block mb-1.5">
                  Time Interval
                </label>
                <Select
                  value={widget.interval || "1h"}
                  onValueChange={(value) =>
                    onChange({ ...widget, interval: value })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="15m">15 minutes</SelectItem>
                    <SelectItem value="1h">1 hour</SelectItem>
                    <SelectItem value="1d">1 day</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* Right: Preview */}
          <div className="border rounded-lg bg-muted/20 flex flex-col">
            <div className="px-3 py-2 border-b text-xs font-medium text-muted-foreground">
              Preview (last 24h)
            </div>
            <div className="p-3 flex-1 flex items-center justify-center">
              {previewResult ? (
                <PreviewResultDisplay result={previewResult} widget={widget} />
              ) : (
                <div className="text-sm text-muted-foreground text-center">
                  Click "Preview" to test your aggregation
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Dashboard Edit Content
// ============================================================================

function DashboardEditContent({ dashboardId }: { dashboardId: string }) {
  const { org, locator } = useProjectContext();
  const queryClient = useQueryClient();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  // Fetch connections for filter
  const allConnections = useConnections();

  // Fetch existing dashboard
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

  // Form state
  const [name, setName] = useState(dashboard?.name ?? "");
  const [description, setDescription] = useState(dashboard?.description ?? "");
  const [widgets, setWidgets] = useState<WidgetInput[]>(
    dashboard?.widgets?.map(widgetToInput) ?? [{ ...DEFAULT_WIDGET }],
  );
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  // Dashboard-level filters state
  const [filterConnectionIds, setFilterConnectionIds] = useState<string[]>(
    dashboard?.filters?.connectionIds ?? [],
  );
  const [filterToolName, setFilterToolName] = useState(
    dashboard?.filters?.toolNames?.[0] ?? "",
  );

  // Preview state (per widget)
  const [previewResults, setPreviewResults] = useState<
    Record<string, PreviewResult>
  >({});
  const [previewingWidgets, setPreviewingWidgets] = useState<Set<string>>(
    new Set(),
  );

  const handleAddWidget = () => {
    setWidgets([...widgets, { ...DEFAULT_WIDGET, id: crypto.randomUUID() }]);
    setHasChanges(true);
  };

  const handleRemoveWidget = (index: number) => {
    setWidgets(widgets.filter((_, i) => i !== index));
    setHasChanges(true);
  };

  const handleWidgetChange = (index: number, widget: WidgetInput) => {
    const updated = [...widgets];
    updated[index] = widget;
    setWidgets(updated);
    setHasChanges(true);
    // Clear preview when widget changes
    setPreviewResults((prev) => {
      const next = { ...prev };
      delete next[widget.id];
      return next;
    });
  };

  const handlePreview = async (widget: WidgetInput) => {
    if (!client) return;

    setPreviewingWidgets((prev) => new Set(prev).add(widget.id));

    try {
      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      // Build dashboard-level filters to apply to preview
      const previewFilters: {
        connectionIds?: string[];
        toolNames?: string[];
      } = {};
      if (filterConnectionIds.length > 0) {
        previewFilters.connectionIds = filterConnectionIds;
      }
      if (filterToolName.trim()) {
        previewFilters.toolNames = [filterToolName.trim()];
      }

      // Use the preview tool which accepts widget config directly
      const result = (await client.callTool({
        name: "MONITORING_WIDGET_PREVIEW",
        arguments: {
          widget: {
            type: widget.type,
            source: {
              path: widget.sourcePath,
              from: widget.sourceFrom,
            },
            aggregation: {
              fn: widget.aggregationFn,
              groupBy:
                widget.type === "table" && widget.groupBy
                  ? widget.groupBy
                  : undefined,
              interval:
                widget.type === "timeseries" && widget.interval
                  ? widget.interval
                  : undefined,
            },
            // Apply dashboard-level filters
            filter:
              Object.keys(previewFilters).length > 0
                ? previewFilters
                : undefined,
          },
          timeRange: {
            startDate: oneDayAgo.toISOString(),
            endDate: now.toISOString(),
          },
        },
      })) as {
        structuredContent?: {
          value?: number | null;
          groups?: Array<{ key: string; value: number }>;
          timeseries?: Array<{ timestamp: string; value: number }>;
          matchedRecords?: number;
        };
      };

      const previewData = result.structuredContent;

      setPreviewResults((prev) => ({
        ...prev,
        [widget.id]: {
          value: previewData?.value,
          groups: previewData?.groups,
          timeseries: previewData?.timeseries,
          matchedRecords: previewData?.matchedRecords ?? 0,
        },
      }));
    } catch (error) {
      console.error("Preview failed:", error);
      setPreviewResults((prev) => ({
        ...prev,
        [widget.id]: {
          error: "Preview failed. Check your JSONPath expression.",
        },
      }));
    } finally {
      setPreviewingWidgets((prev) => {
        const next = new Set(prev);
        next.delete(widget.id);
        return next;
      });
    }
  };

  const handleSave = async () => {
    if (!client) return;
    if (!name.trim()) {
      toast.error("Please enter a dashboard name");
      return;
    }
    if (widgets.some((w) => !w.name.trim())) {
      toast.error("Please enter a name for all widgets");
      return;
    }

    setIsSaving(true);
    try {
      // Build filters object
      const filters: DashboardFilters = {};
      if (filterConnectionIds.length > 0) {
        filters.connectionIds = filterConnectionIds;
      }
      if (filterToolName.trim()) {
        filters.toolNames = [filterToolName.trim()];
      }

      await client.callTool({
        name: "MONITORING_DASHBOARD_UPDATE",
        arguments: {
          id: dashboardId,
          name: name.trim(),
          description: description.trim() || null,
          filters: Object.keys(filters).length > 0 ? filters : null,
          widgets: widgets.map(inputToWidget),
        },
      });

      toast.success("Dashboard saved");
      setHasChanges(false);
      queryClient.invalidateQueries({
        queryKey: KEYS.monitoringDashboards(locator),
      });
      queryClient.invalidateQueries({
        queryKey: KEYS.monitoringDashboardDetails(locator, dashboardId),
      });
    } catch (error) {
      toast.error("Failed to save dashboard");
      console.error(error);
    } finally {
      setIsSaving(false);
    }
  };

  if (!dashboard) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        Dashboard not found
      </div>
    );
  }

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
          <BreadcrumbPage>Edit {dashboard.name}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );

  return (
    <ViewLayout breadcrumb={breadcrumb}>
      <ViewActions>
        <SaveActions
          onSave={handleSave}
          onUndo={() => {
            setName(dashboard?.name ?? "");
            setDescription(dashboard?.description ?? "");
            setWidgets(
              dashboard?.widgets?.map(widgetToInput) ?? [{ ...DEFAULT_WIDGET }],
            );
            setFilterConnectionIds(dashboard?.filters?.connectionIds ?? []);
            setFilterToolName(dashboard?.filters?.toolNames?.[0] ?? "");
            setHasChanges(false);
          }}
          isDirty={hasChanges}
          isSaving={isSaving}
        />
      </ViewActions>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Dashboard Info */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium block mb-1.5">
                Dashboard Name
              </label>
              <Input
                placeholder="e.g., LLM Usage Overview"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setHasChanges(true);
                }}
              />
            </div>
            <div>
              <label className="text-sm font-medium block mb-1.5">
                Description
              </label>
              <Input
                placeholder="What does this dashboard show?"
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  setHasChanges(true);
                }}
              />
            </div>
          </div>

          {/* Dashboard Filters */}
          <div className="border rounded-lg p-4 bg-muted/30">
            <h2 className="text-sm font-medium mb-3">
              Dashboard Filters
              <span className="text-muted-foreground font-normal ml-2">
                (applied to all widgets)
              </span>
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium block mb-1.5">
                  Servers
                </label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-full justify-between font-normal"
                    >
                      <span className="flex items-center gap-2 truncate">
                        {filterConnectionIds.length === 0 ? (
                          <span className="text-muted-foreground">
                            All servers
                          </span>
                        ) : (
                          <>
                            <span className="flex items-center -space-x-1">
                              {filterConnectionIds.slice(0, 3).map((id) => {
                                const conn = (allConnections ?? []).find(
                                  (c) => c.id === id,
                                );
                                if (!conn) return null;
                                return (
                                  <IntegrationIcon
                                    key={id}
                                    icon={conn.icon}
                                    name={conn.title || conn.id}
                                    size="xs"
                                  />
                                );
                              })}
                            </span>
                            <span>
                              {filterConnectionIds.length} server
                              {filterConnectionIds.length !== 1 ? "s" : ""}
                            </span>
                          </>
                        )}
                      </span>
                      <ChevronDown
                        size={14}
                        className="text-muted-foreground shrink-0"
                      />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-72 p-1">
                    <div className="max-h-[240px] overflow-y-auto">
                      {(allConnections ?? []).map((conn) => {
                        const isSelected = filterConnectionIds.includes(
                          conn.id,
                        );
                        return (
                          <button
                            key={conn.id}
                            type="button"
                            className="flex items-center gap-3 w-full rounded-md px-2 py-2 text-sm hover:bg-muted transition-colors"
                            onClick={() => {
                              setFilterConnectionIds((prev) =>
                                isSelected
                                  ? prev.filter((id) => id !== conn.id)
                                  : [...prev, conn.id],
                              );
                              setHasChanges(true);
                            }}
                          >
                            <Checkbox checked={isSelected} />
                            <IntegrationIcon
                              icon={conn.icon}
                              name={conn.title || conn.id}
                              size="xs"
                            />
                            <span className="truncate">
                              {conn.title || conn.id}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {filterConnectionIds.length > 0 && (
                      <div className="border-t p-1">
                        <button
                          type="button"
                          className="w-full text-xs text-muted-foreground hover:text-foreground py-1.5 transition-colors"
                          onClick={() => {
                            setFilterConnectionIds([]);
                            setHasChanges(true);
                          }}
                        >
                          Clear selection
                        </button>
                      </div>
                    )}
                  </PopoverContent>
                </Popover>
              </div>
              <div>
                <label className="text-sm font-medium block mb-1.5">
                  Tool Name Filter
                </label>
                <Input
                  placeholder="e.g., openai_chat"
                  value={filterToolName}
                  onChange={(e) => {
                    setFilterToolName(e.target.value);
                    setHasChanges(true);
                  }}
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Filter to specific tool names (partial match)
                </p>
              </div>
            </div>
          </div>

          {/* Widgets */}
          <div className="mt-12">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-medium">Widgets</h2>
              <Button variant="outline" size="sm" onClick={handleAddWidget}>
                <Plus size={14} className="mr-1.5" />
                Add Widget
              </Button>
            </div>

            <div className="space-y-4">
              {widgets.map((widget, index) => (
                <WidgetEditor
                  key={widget.id}
                  widget={widget}
                  onChange={(w) => handleWidgetChange(index, w)}
                  onRemove={() => handleRemoveWidget(index)}
                  canRemove={widgets.length > 1}
                  onMoveUp={() => {
                    const updated = [...widgets];
                    const prev = updated[index - 1]!;
                    const curr = updated[index]!;
                    updated[index - 1] = curr;
                    updated[index] = prev;
                    setWidgets(updated);
                    setHasChanges(true);
                  }}
                  onMoveDown={() => {
                    const updated = [...widgets];
                    const curr = updated[index]!;
                    const next = updated[index + 1]!;
                    updated[index] = next;
                    updated[index + 1] = curr;
                    setWidgets(updated);
                    setHasChanges(true);
                  }}
                  canMoveUp={index > 0}
                  canMoveDown={index < widgets.length - 1}
                  onPreview={() => handlePreview(widget)}
                  previewResult={previewResults[widget.id] ?? null}
                  isPreviewing={previewingWidgets.has(widget.id)}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </ViewLayout>
  );
}

// ============================================================================
// Main Export
// ============================================================================

export default function DashboardEditPage() {
  const { dashboardId } = useParams({
    from: "/shell/$org/monitoring/dashboards/$dashboardId/edit",
  });

  return (
    <ErrorBoundary
      fallback={
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          Failed to load dashboard editor
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
        <DashboardEditContent dashboardId={dashboardId} />
      </Suspense>
    </ErrorBoundary>
  );
}
