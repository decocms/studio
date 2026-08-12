import { useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import {
  useRegistryMonitorConfig,
  useMonitorResults,
  useMonitorRun,
  useMonitorRunCancel,
  useMonitorConnections,
  useMonitorRunStart,
  useMonitorRuns,
} from "@/hooks/registry/use-monitor";
import type {
  MonitorMode,
  MonitorResult,
  MonitorToolResult,
} from "@/lib/registry/types";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  formatMonitorDuration,
  monitorStatusBadgeClass,
  summarizeToolResults,
} from "@/lib/registry/monitor-utils";
import { Play, StopSquare } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";

function pct(run: { total_items: number; tested_items: number }): number {
  if (!run.total_items) return 0;
  return Math.min(100, Math.round((run.tested_items / run.total_items) * 100));
}

function inferDiscoveredToolsCountFromSummary(
  summary: string | null | undefined,
): number | null {
  if (!summary) return null;
  const match = summary.match(/Not executed tools \((\d+)\/(\d+)\):/i);
  if (!match) return null;
  const total = Number(match[2]);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

function ResultLogEntry({
  result: r,
  index: idx,
  icon,
}: {
  result: MonitorResult;
  index: number;
  icon?: string | null;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const {
    latestToolResults,
    realToolTests,
    isHealthCheck,
    passedTools,
    failedTools,
    hasToolTests,
  } = summarizeToolResults(r.tool_results);
  const testedToolsCount = realToolTests.length;
  const inferredDiscoveredToolsCount = inferDiscoveredToolsCountFromSummary(
    r.agent_summary,
  );
  const discoveredToolsCount = Math.max(
    latestToolResults.length,
    inferredDiscoveredToolsCount ?? 0,
  );
  const toolProgressLabel =
    discoveredToolsCount > 0
      ? t("registry.monitorDashboard.toolsTestedCount", {
          tested: testedToolsCount,
          discovered: discoveredToolsCount,
        })
      : t("registry.monitorDashboard.noTools");

  return (
    <div className="rounded border border-border overflow-hidden">
      <button
        type="button"
        className="w-full text-left flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-muted-foreground w-5 text-right shrink-0">
          {idx + 1}
        </span>
        <div className="size-5 rounded border border-border bg-muted/20 overflow-hidden shrink-0 flex items-center justify-center">
          {icon ? (
            <img
              src={icon}
              alt={r.item_title}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <span className="text-[9px] font-semibold text-muted-foreground">
              {r.item_title.charAt(0).toUpperCase()}
            </span>
          )}
        </div>
        <span
          className={cn(
            "shrink-0",
            r.status === "passed"
              ? "text-success"
              : r.status === "needs_auth"
                ? "text-warning"
                : "text-destructive",
          )}
        >
          {r.status === "passed" ? "✓" : r.status === "needs_auth" ? "🔑" : "✗"}
        </span>
        <span className="font-medium truncate flex-1 min-w-0">
          {r.item_title}
        </span>
        <span className="text-muted-foreground shrink-0">
          {r.duration_ms}ms
        </span>
        <Badge
          variant="outline"
          className={cn(
            "text-[9px] capitalize shrink-0",
            r.status === "passed"
              ? "text-success border-success/20"
              : r.status === "needs_auth"
                ? "text-warning border-warning/20"
                : "text-destructive border-destructive/20",
          )}
        >
          {r.status.replace("_", " ")}
        </Badge>
        {r.connection_ok ? (
          <span
            className="text-[10px] text-success shrink-0"
            title={t("registry.monitorDashboard.connOkTitle")}
          >
            conn✓
          </span>
        ) : (
          <span
            className="text-[10px] text-destructive shrink-0"
            title={t("registry.monitorDashboard.connFailTitle")}
          >
            conn✗
          </span>
        )}
        {r.tools_listed && (
          <span className="text-[10px] text-muted-foreground shrink-0">
            {hasToolTests ? (
              <>
                <span className="text-success">{passedTools}✓</span>{" "}
                <span className={cn(failedTools > 0 ? "text-destructive" : "")}>
                  {failedTools}✗
                </span>
              </>
            ) : isHealthCheck && latestToolResults.length > 0 ? (
              <span>
                {t("registry.monitorDashboard.toolsFoundCount", {
                  count: latestToolResults.length,
                })}
              </span>
            ) : (
              t("registry.monitorDashboard.noToolsLabel")
            )}
          </span>
        )}
        <Badge variant="outline" className="text-[9px] shrink-0">
          {toolProgressLabel}
        </Badge>
        <span className="text-[10px] text-muted-foreground shrink-0">
          {expanded ? "▲" : "▼"}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border px-3 py-2 space-y-2 bg-muted/10">
          {r.error_message && (
            <div className="space-y-0.5">
              <p className="text-[10px] font-semibold text-destructive">
                {t("registry.monitorDashboard.errorLabel")}
              </p>
              <pre className="text-[11px] bg-destructive/5 border border-destructive/10 rounded px-2 py-1.5 whitespace-pre-wrap break-all text-destructive max-h-20 overflow-auto">
                {r.error_message}
              </pre>
            </div>
          )}

          <div className="flex items-center gap-3 text-[10px] flex-wrap">
            <span>
              {t("registry.monitorDashboard.connectionLabel")}{" "}
              <span
                className={cn(
                  r.connection_ok ? "text-success" : "text-destructive",
                )}
              >
                {r.connection_ok
                  ? t("registry.monitorDashboard.statusOk")
                  : t("registry.monitorDashboard.statusFailed")}
              </span>
            </span>
            <span>
              {t("registry.monitorDashboard.toolsListedLabel")}{" "}
              <span
                className={cn(
                  r.tools_listed ? "text-success" : "text-destructive",
                )}
              >
                {r.tools_listed
                  ? t("registry.monitorDashboard.yes")
                  : t("registry.monitorDashboard.no")}
              </span>
            </span>
            {r.action_taken !== "none" && (
              <Badge variant="destructive" className="text-[9px] px-1.5 py-0">
                action: {r.action_taken}
              </Badge>
            )}
          </div>

          {hasToolTests ? (
            <div className="space-y-1">
              <p className="text-[10px] font-semibold text-muted-foreground">
                {t("registry.monitorDashboard.toolsTestedDetails", {
                  passed: passedTools,
                  failed: failedTools,
                })}
              </p>
              <div className="space-y-0.5">
                {realToolTests.map((tool, toolIndex) => (
                  <ToolMiniRow
                    key={`${r.id}-${tool.toolName}-${toolIndex}`}
                    tool={tool}
                  />
                ))}
              </div>
            </div>
          ) : isHealthCheck && latestToolResults.length > 0 ? (
            <div className="space-y-1">
              <p className="text-[10px] font-semibold text-muted-foreground">
                {t("registry.monitorDashboard.toolsDiscoveredHealthCheck", {
                  count: latestToolResults.length,
                })}
              </p>
              <div className="flex flex-wrap gap-1">
                {latestToolResults.map((tool, toolIndex) => (
                  <Badge
                    key={`${r.id}-${tool.toolName}-${toolIndex}`}
                    variant="outline"
                    className="text-[10px] font-mono"
                  >
                    {tool.toolName}
                  </Badge>
                ))}
              </div>
            </div>
          ) : r.tools_listed ? (
            <p className="text-[10px] text-muted-foreground italic">
              {t("registry.monitorDashboard.noToolsFound")}
            </p>
          ) : null}

          {r.agent_summary && (
            <p className="text-[11px] bg-muted/50 rounded px-2 py-1.5">
              {r.agent_summary}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ToolMiniRow({ tool }: { tool: MonitorToolResult }) {
  const t = useT();
  const [showDetails, setShowDetails] = useState(false);
  return (
    <div className="rounded border border-border overflow-hidden">
      <button
        type="button"
        className="w-full text-left flex items-center gap-2 px-2 py-1 text-[11px] hover:bg-muted/30 transition-colors"
        onClick={() => setShowDetails(!showDetails)}
      >
        <span
          className={cn(
            "font-bold",
            tool.success ? "text-success" : "text-destructive",
          )}
        >
          {tool.success ? "✓" : "✗"}
        </span>
        <span className="font-mono truncate flex-1">{tool.toolName}</span>
        <span className="text-muted-foreground shrink-0">
          {tool.durationMs}ms
        </span>
        {tool.error && (
          <span
            className="text-destructive truncate max-w-28"
            title={tool.error}
          >
            {tool.error}
          </span>
        )}
        <span className="text-muted-foreground">{showDetails ? "▲" : "▼"}</span>
      </button>
      {showDetails && (
        <div className="border-t border-border px-2 py-1.5 space-y-1 bg-muted/10 text-[11px]">
          {tool.error && (
            <pre className="bg-destructive/5 border border-destructive/10 rounded px-2 py-1 whitespace-pre-wrap break-all text-destructive max-h-20 overflow-auto">
              {tool.error}
            </pre>
          )}
          {tool.input && Object.keys(tool.input).length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground">
                {t("registry.monitorDashboard.inputLabel")}
              </p>
              <pre className="bg-muted/50 rounded px-2 py-1 whitespace-pre-wrap break-all max-h-16 overflow-auto">
                {JSON.stringify(tool.input, null, 2)}
              </pre>
            </div>
          )}
          {tool.outputPreview && (
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground">
                {t("registry.monitorDashboard.outputLabel")}
              </p>
              <pre className="bg-muted/50 rounded px-2 py-1 whitespace-pre-wrap break-all max-h-16 overflow-auto">
                {tool.outputPreview}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function MonitorDashboard({
  activeRunId,
  onRunChange,
}: {
  activeRunId?: string;
  onRunChange: (runId: string | undefined) => void;
}) {
  const t = useT();
  const { settings } = useRegistryMonitorConfig();
  const [modeOverride, setModeOverride] = useState<MonitorMode | null>(null);
  const [confirmStartOpen, setConfirmStartOpen] = useState(false);
  const lastStartRef = useRef(0);
  const lastAutoSelectedRunRef = useRef<string | null>(null);
  const runStartMutation = useMonitorRunStart();
  const runCancelMutation = useMonitorRunCancel();
  const runQuery = useMonitorRun(activeRunId);
  const runsQuery = useMonitorRuns();
  const monitorConnectionsQuery = useMonitorConnections();
  const run = runQuery.data?.run ?? null;
  const runStatus = run?.status;
  const runConfigMode =
    run?.config_snapshot?.monitorMode ??
    (run?.config_snapshot as { testMode?: string } | null)?.testMode;
  const allResults = useMonitorResults(activeRunId, undefined, runStatus);
  const runningRun = (runsQuery.data?.items ?? []).find(
    (runItem) => runItem.status === "running",
  );
  const latestRunId = runsQuery.data?.items?.[0]?.id;

  // If no run is selected, automatically show the most recent one.
  if (
    !activeRunId &&
    latestRunId &&
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    lastAutoSelectedRunRef.current !== latestRunId
  ) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    lastAutoSelectedRunRef.current = latestRunId;
    queueMicrotask(() => {
      onRunChange(latestRunId);
    });
  }

  const startMonitor = async () => {
    const now = Date.now();
    if (now - lastStartRef.current < 1000) {
      return;
    }
    lastStartRef.current = now;
    const effectiveMode = modeOverride ?? settings.monitorMode;
    const created = await runStartMutation.mutateAsync({
      ...settings,
      monitorMode: effectiveMode,
    });
    onRunChange(created.run.id);
  };

  const onStart = async () => {
    if (
      runningRun &&
      runningRun.id !== activeRunId &&
      runningRun.status === "running"
    ) {
      setConfirmStartOpen(true);
      return;
    }
    await startMonitor();
  };

  const onCancel = async () => {
    if (!activeRunId) return;
    await runCancelMutation.mutateAsync(activeRunId);
  };

  const isRunning = run?.status === "running";
  const duration = run
    ? formatMonitorDuration(run.started_at, run.finished_at)
    : null;
  const resultItems = allResults.data?.items ?? [];
  const iconByItemId = (monitorConnectionsQuery.data?.items ?? []).reduce(
    (acc, entry) => {
      acc[entry.mapping.item_id] = entry.item?.server?.icons?.[0]?.src ?? null;
      return acc;
    },
    {} as Record<string, string | null>,
  );
  const selectedMode = modeOverride ?? settings.monitorMode;

  return (
    <div className="space-y-4 min-w-0">
      <div className="space-y-4 min-w-0">
        <Card className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h3 className="text-sm font-semibold">
                {t("registry.monitorDashboard.currentQaRunTitle")}
              </h3>
              <p className="text-xs text-muted-foreground">
                {t("registry.monitorDashboard.currentQaRunDescription")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {runningRun && runningRun.id !== activeRunId && (
                <Badge variant="outline" className="text-[10px]">
                  {t("registry.monitorDashboard.runInProgressBadge", {
                    runId: runningRun.id.slice(0, 8),
                  })}
                </Badge>
              )}
              <Button
                size="sm"
                onClick={onStart}
                disabled={runStartMutation.isPending || isRunning}
                className="gap-1.5"
              >
                <Play size={14} />
                {runStartMutation.isPending
                  ? t("registry.monitorDashboard.startingButton")
                  : runningRun && runningRun.id !== activeRunId
                    ? t("registry.monitorDashboard.startAnotherRunButton")
                    : t("registry.monitorDashboard.startQaRunButton")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={onCancel}
                disabled={!activeRunId || !isRunning}
                className="gap-1.5"
              >
                <StopSquare size={14} />
                {t("registry.monitorDashboard.cancelButton")}
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="text-[11px] text-muted-foreground">
                {t("registry.monitorDashboard.qaModeLabel")}
              </span>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={selectedMode}
                onChange={(e) => setModeOverride(e.target.value as MonitorMode)}
                disabled={isRunning}
              >
                <option value="health_check">
                  {t("registry.monitorDashboard.modeHealthCheck")}
                </option>
                <option value="tool_call">
                  {t("registry.monitorDashboard.modeToolCall")}
                </option>
                <option value="full_agent">
                  {t("registry.monitorDashboard.modeAgentic")}
                </option>
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-[11px] text-muted-foreground">
                {t("registry.monitorDashboard.qaRunHistoryLabel")}
              </span>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={activeRunId ?? ""}
                onChange={(e) => onRunChange(e.target.value || undefined)}
              >
                <option value="">
                  {t("registry.monitorDashboard.autoSelectLatestRun")}
                </option>
                {(runsQuery.data?.items ?? []).map((runItem) => (
                  <option key={runItem.id} value={runItem.id}>
                    {new Date(runItem.created_at).toLocaleString()} -{" "}
                    {runItem.status}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <p className="text-[11px] text-muted-foreground rounded-md bg-muted/30 px-2.5 py-2">
            {selectedMode === "health_check"
              ? t("registry.monitorDashboard.modeDescriptionHealthCheck")
              : selectedMode === "tool_call"
                ? t("registry.monitorDashboard.modeDescriptionToolCall")
                : t("registry.monitorDashboard.modeDescriptionAgentic")}
          </p>

          {run ? (
            <>
              <div className="flex items-center gap-3 flex-wrap">
                <Badge
                  className={cn(
                    "capitalize",
                    monitorStatusBadgeClass(run.status),
                    run.status === "running" ? "animate-pulse" : "",
                  )}
                >
                  {run.status}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {t("registry.monitorDashboard.itemsTestedCount", {
                    tested: run.tested_items,
                    total: run.total_items,
                  })}
                </span>
                {duration && (
                  <span className="text-xs text-muted-foreground">
                    {duration}
                  </span>
                )}
                {isRunning && run.current_item_id && (
                  <span className="text-xs text-muted-foreground truncate max-w-64">
                    {t("registry.monitorDashboard.qaOnLabel")}{" "}
                    <span className="font-mono">{run.current_item_id}</span>
                  </span>
                )}
              </div>

              <div className="h-2.5 rounded-full bg-muted overflow-hidden">
                <div
                  className={cn(
                    "h-full transition-all duration-500",
                    run.failed_items > 0 ? "bg-warning" : "bg-success",
                    isRunning ? "animate-pulse" : "",
                  )}
                  style={{ width: `${pct(run)}%` }}
                />
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <Card className="p-2.5 space-y-0.5">
                  <p className="text-[10px] text-success">
                    {t("registry.monitorDashboard.passedLabel")}
                  </p>
                  <p className="text-lg font-bold text-success">
                    {run.passed_items}
                  </p>
                </Card>
                <Card className="p-2.5 space-y-0.5">
                  <p className="text-[10px] text-destructive">
                    {t("registry.monitorDashboard.failedLabel")}
                  </p>
                  <p className="text-lg font-bold text-destructive">
                    {run.failed_items}
                  </p>
                </Card>
                <Card className="p-2.5 space-y-0.5">
                  <p className="text-[10px] text-muted-foreground">
                    {t("registry.monitorDashboard.skippedLabel")}
                  </p>
                  <p className="text-lg font-bold">{run.skipped_items}</p>
                </Card>
                <Card className="p-2.5 space-y-0.5">
                  <p className="text-[10px] text-muted-foreground">
                    {t("registry.monitorDashboard.totalLabel")}
                  </p>
                  <p className="text-lg font-bold">{run.total_items}</p>
                </Card>
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("registry.monitorDashboard.noRunSelectedMessage")}
            </p>
          )}
        </Card>

        <Card className="p-4 space-y-2 min-h-[360px]">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">
                {t("registry.monitorDashboard.qaResultsLogTitle", {
                  count: resultItems.length,
                })}
              </h3>
              <p className="text-[11px] text-muted-foreground">
                {t("registry.monitorDashboard.qaResultsLogDescription")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {isRunning && (
                <Badge className="bg-primary/10 text-primary border-primary/20 animate-pulse">
                  {t("registry.monitorDashboard.runInProgressLabel")}
                </Badge>
              )}
              {run && (
                <Badge variant="outline" className="text-[10px]">
                  {t("registry.monitorDashboard.progressBadge", {
                    tested: run.tested_items,
                    total: run.total_items,
                  })}
                </Badge>
              )}
              {runConfigMode && (
                <Badge variant="outline" className="text-[10px]">
                  {t("registry.monitorDashboard.modeBadge", {
                    mode: runConfigMode.replace("_", " "),
                  })}
                </Badge>
              )}
            </div>
          </div>

          {resultItems.length === 0 ? (
            <div className="h-[280px] rounded border border-dashed border-border flex items-center justify-center text-xs text-muted-foreground">
              {t("registry.monitorDashboard.noResultsYetMessage")}
            </div>
          ) : (
            <div
              ref={(node) => {
                if (node && isRunning) {
                  // Only auto-scroll when the user is near the bottom (within 120px)
                  const distanceFromBottom =
                    node.scrollHeight - node.scrollTop - node.clientHeight;
                  if (distanceFromBottom < 120) {
                    requestAnimationFrame(() => {
                      node.scrollTop = node.scrollHeight;
                    });
                  }
                }
              }}
              className="space-y-1 max-h-[60vh] overflow-auto pr-1"
            >
              {resultItems.map((r, idx) => (
                <ResultLogEntry
                  key={r.id}
                  result={r}
                  index={idx}
                  icon={iconByItemId[r.item_id]}
                />
              ))}
            </div>
          )}
        </Card>
      </div>

      <AlertDialog open={confirmStartOpen} onOpenChange={setConfirmStartOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("registry.monitorDashboard.confirmStartTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("registry.monitorDashboard.confirmStartDescription", {
                runId: runningRun ? ` (${runningRun.id})` : "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("registry.monitorDashboard.cancelButtonDialog")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmStartOpen(false);
                void startMonitor();
              }}
            >
              {t("registry.monitorDashboard.startAnywayButton")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
