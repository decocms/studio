import { useState } from "react";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Card } from "@deco/ui/components/card.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  useMonitorResults,
  useMonitorRun,
} from "@/web/hooks/registry/use-monitor";
import { collapseLatestToolResults } from "@/web/lib/registry/monitor-utils";
import type {
  MonitorResult,
  MonitorResultStatus,
  MonitorToolResult,
} from "@/web/lib/registry/types";

function statusColor(status: MonitorResultStatus) {
  switch (status) {
    case "passed":
      return "bg-emerald-500/10 text-emerald-600 border-emerald-500/20";
    case "failed":
      return "bg-red-500/10 text-red-600 border-red-500/20";
    case "error":
      return "bg-orange-500/10 text-orange-600 border-orange-500/20";
    case "needs_auth":
      return "bg-amber-500/10 text-amber-600 border-amber-500/20";
    case "skipped":
      return "bg-zinc-500/10 text-zinc-500 border-zinc-500/20";
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
            tool.success ? "text-emerald-600" : "text-red-600",
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
              <p className="text-[10px] font-semibold text-red-600">Error</p>
              <pre className="text-[11px] bg-red-500/5 border border-red-500/10 rounded px-2 py-1.5 whitespace-pre-wrap break-all text-red-700">
                {tool.error}
              </pre>
            </div>
          )}
          {tool.input && Object.keys(tool.input).length > 0 && (
            <div className="space-y-0.5">
              <p className="text-[10px] font-semibold text-muted-foreground">
                Input
              </p>
              <pre className="text-[11px] bg-muted/50 rounded px-2 py-1.5 whitespace-pre-wrap break-all max-h-24 overflow-auto">
                {JSON.stringify(tool.input, null, 2)}
              </pre>
            </div>
          )}
          {tool.outputPreview && (
            <div className="space-y-0.5">
              <p className="text-[10px] font-semibold text-muted-foreground">
                Output preview
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
                No additional details.
              </p>
            )}
        </div>
      )}
    </div>
  );
}

function ResultCard({ result }: { result: MonitorResult }) {
  const [expanded, setExpanded] = useState(result.status !== "passed");

  const latestToolResults = collapseLatestToolResults(result.tool_results);
  const isHealthCheck = latestToolResults.every(
    (t) => t.outputPreview === "health_check: not called",
  );
  const realToolTests = latestToolResults.filter(
    (t) => t.outputPreview !== "health_check: not called",
  );
  const passedTools = realToolTests.filter((t) => t.success).length;
  const failedTools = realToolTests.filter((t) => !t.success).length;
  const hasTestedTools = realToolTests.length > 0;

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
              conn: {result.connection_ok ? "✓" : "✗"}
            </span>
            <span className="text-[10px] text-muted-foreground">
              tools listed: {result.tools_listed ? "✓" : "✗"}
            </span>
            {latestToolResults.length > 0 && (
              <span className="text-[10px] text-muted-foreground">
                {hasTestedTools ? (
                  <>
                    tools: {passedTools}✓ {failedTools}✗
                  </>
                ) : (
                  <>{latestToolResults.length} tools found</>
                )}
              </span>
            )}
            {result.action_taken !== "none" && (
              <Badge variant="destructive" className="text-[9px] px-1.5 py-0">
                action: {result.action_taken}
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
              <p className="text-[10px] text-muted-foreground">Connection</p>
              <p
                className={cn(
                  "text-xs font-medium",
                  result.connection_ok ? "text-emerald-600" : "text-red-600",
                )}
              >
                {result.connection_ok ? "Connected" : "Failed"}
              </p>
            </div>
            <div className="rounded border border-border px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground">Tools Listed</p>
              <p
                className={cn(
                  "text-xs font-medium",
                  result.tools_listed ? "text-emerald-600" : "text-red-600",
                )}
              >
                {result.tools_listed
                  ? `Yes (${latestToolResults.length})`
                  : "No"}
              </p>
            </div>
            <div className="rounded border border-border px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground">Duration</p>
              <p className="text-xs font-medium">{result.duration_ms}ms</p>
            </div>
            <div className="rounded border border-border px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground">Action Taken</p>
              <p className="text-xs font-medium capitalize">
                {result.action_taken.replace(/_/g, " ")}
              </p>
            </div>
          </div>

          {/* Error message */}
          {result.error_message && (
            <div className="space-y-1">
              <p className="text-[10px] font-semibold text-red-600">
                Error Message
              </p>
              <pre className="text-xs bg-red-500/5 border border-red-500/10 rounded px-3 py-2 whitespace-pre-wrap break-all text-red-700">
                {result.error_message}
              </pre>
            </div>
          )}

          {/* Tool results */}
          {hasTestedTools ? (
            <div className="space-y-1">
              <p className="text-[10px] font-semibold text-muted-foreground">
                Tool Results ({passedTools} passed, {failedTools} failed)
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
                Tools discovered ({latestToolResults.length}) — not individually
                tested (health-check mode)
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
                Agent Summary
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
  const options: Array<{ value: MonitorResultStatus | "all"; label: string }> =
    [
      { value: "all", label: "All" },
      { value: "passed", label: "Passed" },
      { value: "failed", label: "Failed" },
      { value: "error", label: "Error" },
      { value: "needs_auth", label: "Needs Auth" },
      { value: "skipped", label: "Skipped" },
    ];
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
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function MonitorRunDetail({ runId }: { runId?: string }) {
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
          Select a run to inspect details.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <Card className="p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Run Detail</h3>
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
              Refresh
            </Button>
          </div>
        </div>
      </Card>

      {run && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
          <Card className="p-2.5 space-y-0.5">
            <p className="text-[10px] text-muted-foreground">Total</p>
            <p className="text-lg font-bold">{run.total_items}</p>
          </Card>
          <Card className="p-2.5 space-y-0.5">
            <p className="text-[10px] text-muted-foreground">Tested</p>
            <p className="text-lg font-bold">{run.tested_items}</p>
          </Card>
          <Card className="p-2.5 space-y-0.5">
            <p className="text-[10px] text-emerald-600">Passed</p>
            <p className="text-lg font-bold text-emerald-600">
              {run.passed_items}
            </p>
          </Card>
          <Card className="p-2.5 space-y-0.5">
            <p className="text-[10px] text-red-600">Failed</p>
            <p className="text-lg font-bold text-red-600">{run.failed_items}</p>
          </Card>
          <Card className="p-2.5 space-y-0.5">
            <p className="text-[10px] text-muted-foreground">Skipped</p>
            <p className="text-lg font-bold">{run.skipped_items}</p>
          </Card>
        </div>
      )}

      {/* Time info */}
      {run && (run.started_at || run.finished_at) && (
        <Card className="p-3 flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
          {run.started_at && (
            <span>Started: {new Date(run.started_at).toLocaleString()}</span>
          )}
          {run.finished_at && (
            <span>Finished: {new Date(run.finished_at).toLocaleString()}</span>
          )}
          {run.started_at && run.finished_at && (
            <span className="font-medium text-foreground">
              Duration:{" "}
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
          {filteredResults.length} result
          {filteredResults.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Results */}
      <div className="space-y-2">
        {filteredResults.length === 0 && (
          <Card className="p-4 text-sm text-muted-foreground text-center">
            {allResults.length === 0
              ? "No test results yet."
              : "No results match the current filter."}
          </Card>
        )}
        {filteredResults.map((result) => (
          <ResultCard key={result.id} result={result} />
        ))}
      </div>
    </div>
  );
}
