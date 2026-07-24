import { useState } from "react";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Card } from "@deco/ui/components/card.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useMonitorResults, useMonitorRun } from "@/hooks/registry/use-monitor";
import { summarizeToolResults } from "@/lib/registry/monitor-utils";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import type {
  MonitorResult,
  MonitorResultStatus,
  MonitorToolResult,
} from "@/lib/registry/types";

function statusColor(status: MonitorResultStatus) {
  switch (status) {
    case "passed":
      return "bg-success/10 text-success border-success/20";
    case "failed":
    case "error":
      return "bg-destructive/10 text-destructive border-destructive/20";
    case "needs_auth":
      return "bg-warning/10 text-warning border-warning/20";
    case "skipped":
      return "bg-muted text-muted-foreground border-border";
    default:
      return "";
  }
}

function statusIcon(status: MonitorResultStatus) {
  switch (status) {
    case "passed":
      return "✓";
    case "failed":
      return "✗";
    case "error":
      return "⚠";
    case "needs_auth":
      return "🔑";
    case "skipped":
      return "⏭";
    default:
      return "?";
  }
}

function ToolResultRow({ tool }: { tool: MonitorToolResult }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded border border-border">
      <button
        type="button"
        className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span
          className={cn(
            "text-xs font-bold",
            tool.success ? "text-success" : "text-destructive",
          )}
        >
          {tool.success ? "✓" : "✗"}
        </span>
        <span className="text-xs font-mono truncate flex-1">
          {tool.toolName}
        </span>
        <span className="text-[10px] text-muted-foreground shrink-0">
          {tool.durationMs}ms
        </span>
        <span className="text-[10px] text-muted-foreground">
          {expanded ? "▲" : "▼"}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-2 space-y-1.5 bg-muted/20">
          {tool.error && (
            <div className="space-y-0.5">
              <p className="text-[10px] font-semibold text-destructive">
                {t("registry.monitorRunDetail.error")}
              </p>
              <pre className="text-[11px] bg-destructive/5 border border-destructive/10 rounded px-2 py-1.5 whitespace-pre-wrap break-all text-destructive">
                {tool.error}
              </pre>
            </div>
          )}
          {tool.input && Object.keys(tool.input).length > 0 && (
            <div className="space-y-0.5">
              <p className="text-[10px] font-semibold text-muted-foreground">
                {t("registry.monitorRunDetail.input")}
              </p>
              <pre className="text-[11px] bg-muted/50 rounded px-2 py-1.5 whitespace-pre-wrap break-all max-h-24 overflow-auto">
                {JSON.stringify(tool.input, null, 2)}
              </pre>
            </div>
          )}
          {tool.outputPreview && (
            <div className="space-y-0.5">
              <p className="text-[10px] font-semibold text-muted-foreground">
                {t("registry.monitorRunDetail.outputPreview")}
              </p>
              <pre className="text-[11px] bg-muted/50 rounded px-2 py-1.5 whitespace-pre-wrap break-all max-h-24 overflow-auto">
                {tool.outputPreview}
              </pre>
            </div>
          )}
          {!tool.error &&
            !tool.outputPreview &&
            (!tool.input || Object.keys(tool.input).length === 0) && (
              <p className="text-[10px] text-muted-foreground">
                {t("registry.monitorRunDetail.noAdditionalDetails")}
              </p>
            )}
        </div>
      )}
    </div>
  );
}

function ResultCard({ result }: { result: MonitorResult }) {
  const t = useT();
  const [expanded, setExpanded] = useState(result.status !== "passed");

  const {
    latestToolResults,
    realToolTests,
    isHealthCheck,
    passedTools,
    failedTools,
    hasToolTests: hasTestedTools,
  } = summarizeToolResults(result.tool_results);

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <button
        type="button"
        className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-base shrink-0">{statusIcon(result.status)}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{result.item_title}</p>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <span className="text-[10px] text-muted-foreground">
              {result.duration_ms}ms
            </span>
            <span className="text-[10px] text-muted-foreground">
              {t("registry.monitorRunDetail.conn")}:{" "}
              {result.connection_ok ? "✓" : "✗"}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {t("registry.monitorRunDetail.toolsListed")}:{" "}
              {result.tools_listed ? "✓" : "✗"}
            </span>
            {latestToolResults.length > 0 && (
              <span className="text-[10px] text-muted-foreground">
                {hasTestedTools ? (
                  <>
                    {t("registry.monitorRunDetail.tools")}: {passedTools}✓{" "}
                    {failedTools}✗
                  </>
                ) : (
                  <>
                    {latestToolResults.length}{" "}
                    {t("registry.monitorRunDetail.toolsFound")}
                  </>
                )}
              </span>
            )}
            {result.action_taken !== "none" && (
              <Badge variant="destructive" className="text-[9px] px-1.5 py-0">
                {t("registry.monitorRunDetail.action")}: {result.action_taken}
              </Badge>
            )}
          </div>
        </div>
        <Badge
          className={cn("capitalize shrink-0", statusColor(result.status))}
        >
          {result.status.replace("_", " ")}
        </Badge>
        <span className="text-xs text-muted-foreground shrink-0">
          {expanded ? "▲" : "▼"}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border px-4 py-3 space-y-2 bg-muted/10">
          {/* Connection & listing info */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div className="rounded border border-border px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground">
                {t("registry.monitorRunDetail.connection")}
              </p>
              <p
                className={cn(
                  "text-xs font-medium",
                  result.connection_ok ? "text-success" : "text-destructive",
                )}
              >
                {result.connection_ok
                  ? t("registry.monitorRunDetail.connected")
                  : t("registry.monitorRunDetail.failed")}
              </p>
            </div>
            <div className="rounded border border-border px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground">
                {t("registry.monitorRunDetail.toolsListedLabel")}
              </p>
              <p
                className={cn(
                  "text-xs font-medium",
                  result.tools_listed ? "text-success" : "text-destructive",
                )}
              >
                {result.tools_listed
                  ? t("registry.monitorRunDetail.yesWithCount", {
                      count: latestToolResults.length,
                    })
                  : t("registry.monitorRunDetail.no")}
              </p>
            </div>
            <div className="rounded border border-border px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground">
                {t("registry.monitorRunDetail.duration")}
              </p>
              <p className="text-xs font-medium">{result.duration_ms}ms</p>
            </div>
            <div className="rounded border border-border px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground">
                {t("registry.monitorRunDetail.actionTaken")}
              </p>
              <p className="text-xs font-medium capitalize">
                {result.action_taken.replace(/_/g, " ")}
              </p>
            </div>
          </div>

          {/* Error message */}
          {result.error_message && (
            <div className="space-y-1">
              <p className="text-[10px] font-semibold text-destructive">
                {t("registry.monitorRunDetail.errorMessage")}
              </p>
              <pre className="text-xs bg-destructive/5 border border-destructive/10 rounded px-3 py-2 whitespace-pre-wrap break-all text-destructive">
                {result.error_message}
              </pre>
            </div>
          )}

          {/* Tool results */}
          {hasTestedTools ? (
            <div className="space-y-1">
              <p className="text-[10px] font-semibold text-muted-foreground">
                {t("registry.monitorRunDetail.toolResults", {
                  passed: passedTools,
                  failed: failedTools,
                })}
              </p>
              <div className="space-y-1">
                {realToolTests.map((tool, index) => (
                  <ToolResultRow
                    key={`${result.id}-${tool.toolName}-${index}`}
                    tool={tool}
                  />
                ))}
              </div>
            </div>
          ) : isHealthCheck && latestToolResults.length > 0 ? (
            <div className="space-y-1">
              <p className="text-[10px] font-semibold text-muted-foreground">
                {t("registry.monitorRunDetail.toolsDiscovered", {
                  count: latestToolResults.length,
                })}
              </p>
              <div className="flex flex-wrap gap-1">
                {latestToolResults.map((tool, index) => (
                  <Badge
                    key={`${result.id}-${tool.toolName}-${index}`}
                    variant="outline"
                    className="text-[10px] font-mono"
                  >
                    {tool.toolName}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}

          {/* Agent summary */}
          {result.agent_summary && (
            <div className="space-y-1">
              <p className="text-[10px] font-semibold text-muted-foreground">
                {t("registry.monitorRunDetail.agentSummary")}
              </p>
              <p className="text-xs bg-muted/50 rounded px-3 py-2">
                {result.agent_summary}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusFilter({
  value,
  onChange,
}: {
  value: MonitorResultStatus | "all";
  onChange: (v: MonitorResultStatus | "all") => void;
}) {
  const t = useT();
  const options = [
    { value: "all", labelKey: "registry.monitorRunDetail.filterAll" },
    { value: "passed", labelKey: "registry.monitorRunDetail.filterPassed" },
    { value: "failed", labelKey: "registry.monitorRunDetail.filterFailed" },
    { value: "error", labelKey: "registry.monitorRunDetail.filterError" },
    {
      value: "needs_auth",
      labelKey: "registry.monitorRunDetail.filterNeedsAuth",
    },
    { value: "skipped", labelKey: "registry.monitorRunDetail.filterSkipped" },
  ] as const satisfies ReadonlyArray<{
    value: MonitorResultStatus | "all";
    labelKey: TranslationKey;
  }>;
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={cn(
            "text-[11px] px-2 py-0.5 rounded-full border transition-colors",
            value === opt.value
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-muted/30 border-border hover:bg-muted/50",
          )}
          onClick={() => onChange(opt.value)}
        >
          {t(opt.labelKey)}
        </button>
      ))}
    </div>
  );
}

export function MonitorRunDetail({ runId }: { runId?: string }) {
  const t = useT();
  const [statusFilter, setStatusFilter] = useState<MonitorResultStatus | "all">(
    "all",
  );
  const runQuery = useMonitorRun(runId);
  const run = runQuery.data?.run;
  const resultsQuery = useMonitorResults(runId, undefined, run?.status);
  const allResults = resultsQuery.data?.items ?? [];
  const filteredResults =
    statusFilter === "all"
      ? allResults
      : allResults.filter((r) => r.status === statusFilter);

  if (!runId) {
    return (
      <Card className="p-6 text-center space-y-2">
        <p className="text-sm text-muted-foreground">
          {t("registry.monitorRunDetail.selectRunToInspect")}
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <Card className="p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">
              {t("registry.monitorRunDetail.runDetail")}
            </h3>
            <p className="text-[10px] text-muted-foreground font-mono">
              {runId}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {run && (
              <Badge
                className={cn(
                  "capitalize",
                  statusColor(run.status as MonitorResultStatus),
                )}
              >
                {run.status}
              </Badge>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                runQuery.refetch();
                resultsQuery.refetch();
              }}
            >
              {t("registry.monitorRunDetail.refresh")}
            </Button>
          </div>
        </div>
      </Card>

      {run && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
          <Card className="p-2.5 space-y-0.5">
            <p className="text-[10px] text-muted-foreground">
              {t("registry.monitorRunDetail.total")}
            </p>
            <p className="text-lg font-bold">{run.total_items}</p>
          </Card>
          <Card className="p-2.5 space-y-0.5">
            <p className="text-[10px] text-muted-foreground">
              {t("registry.monitorRunDetail.tested")}
            </p>
            <p className="text-lg font-bold">{run.tested_items}</p>
          </Card>
          <Card className="p-2.5 space-y-0.5">
            <p className="text-[10px] text-success">
              {t("registry.monitorRunDetail.passed")}
            </p>
            <p className="text-lg font-bold text-success">{run.passed_items}</p>
          </Card>
          <Card className="p-2.5 space-y-0.5">
            <p className="text-[10px] text-destructive">
              {t("registry.monitorRunDetail.failed")}
            </p>
            <p className="text-lg font-bold text-destructive">
              {run.failed_items}
            </p>
          </Card>
          <Card className="p-2.5 space-y-0.5">
            <p className="text-[10px] text-muted-foreground">
              {t("registry.monitorRunDetail.skipped")}
            </p>
            <p className="text-lg font-bold">{run.skipped_items}</p>
          </Card>
        </div>
      )}

      {/* Time info */}
      {run && (run.started_at || run.finished_at) && (
        <Card className="p-3 flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
          {run.started_at && (
            <span>
              {t("registry.monitorRunDetail.started")}:{" "}
              {new Date(run.started_at).toLocaleString()}
            </span>
          )}
          {run.finished_at && (
            <span>
              {t("registry.monitorRunDetail.finished")}:{" "}
              {new Date(run.finished_at).toLocaleString()}
            </span>
          )}
          {run.started_at && run.finished_at && (
            <span className="font-medium text-foreground">
              {t("registry.monitorRunDetail.durationLabel")}:{" "}
              {(
                (new Date(run.finished_at).getTime() -
                  new Date(run.started_at).getTime()) /
                1000
              ).toFixed(1)}
              s
            </span>
          )}
        </Card>
      )}

      {/* Filter bar */}
      <div className="flex items-center justify-between gap-2">
        <StatusFilter value={statusFilter} onChange={setStatusFilter} />
        <span className="text-xs text-muted-foreground">
          {filteredResults.length}{" "}
          {t("registry.monitorRunDetail.result", {
            count: filteredResults.length,
          })}
        </span>
      </div>

      {/* Results */}
      <div className="space-y-2">
        {filteredResults.length === 0 && (
          <Card className="p-4 text-sm text-muted-foreground text-center">
            {allResults.length === 0
              ? t("registry.monitorRunDetail.noTestResultsYet")
              : t("registry.monitorRunDetail.noResultsMatchFilter")}
          </Card>
        )}
        {filteredResults.map((result) => (
          <ResultCard key={result.id} result={result} />
        ))}
      </div>
    </div>
  );
}
