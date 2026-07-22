import type { MonitorToolResult } from "./types";

export function monitorStatusBadgeClass(status: string): string {
  switch (status) {
    case "running":
      return "bg-primary/10 text-primary border-primary/20";
    case "completed":
      return "bg-success/10 text-success border-success/20";
    case "failed":
      return "bg-destructive/10 text-destructive border-destructive/20";
    case "cancelled":
      return "bg-muted text-muted-foreground border-border";
    case "pending":
      return "bg-warning/10 text-warning border-warning/20";
    default:
      return "";
  }
}

export function formatMonitorDuration(
  startedAt: string | null,
  finishedAt: string | null,
): string | null {
  if (!startedAt) return null;
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const start = new Date(startedAt).getTime();
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function collapseLatestToolResults(
  toolResults: MonitorToolResult[],
): MonitorToolResult[] {
  const byToolName = new Map<string, MonitorToolResult>();
  for (const result of toolResults) {
    if (byToolName.has(result.toolName)) {
      byToolName.delete(result.toolName);
    }
    byToolName.set(result.toolName, result);
  }
  return Array.from(byToolName.values());
}

export interface ToolResultSummary {
  latestToolResults: MonitorToolResult[];
  realToolTests: MonitorToolResult[];
  isHealthCheck: boolean;
  passedTools: number;
  failedTools: number;
  hasToolTests: boolean;
}

export function summarizeToolResults(
  toolResults: MonitorToolResult[],
): ToolResultSummary {
  const latestToolResults = collapseLatestToolResults(toolResults);
  const isHealthCheck = latestToolResults.every(
    (t) => t.outputPreview === "health_check: not called",
  );
  const realToolTests = latestToolResults.filter(
    (t) => t.outputPreview !== "health_check: not called",
  );
  const passedTools = realToolTests.filter((t) => t.success).length;
  const failedTools = realToolTests.filter((t) => !t.success).length;
  return {
    latestToolResults,
    realToolTests,
    isHealthCheck,
    passedTools,
    failedTools,
    hasToolTests: realToolTests.length > 0,
  };
}
