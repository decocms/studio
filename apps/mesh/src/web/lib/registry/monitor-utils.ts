import type { MonitorToolResult } from "./types";

export function monitorStatusBadgeClass(status: string): string {
  switch (status) {
    case "running":
      return "bg-blue-500/10 text-blue-600 border-blue-500/20";
    case "completed":
      return "bg-emerald-500/10 text-emerald-600 border-emerald-500/20";
    case "failed":
      return "bg-red-500/10 text-red-600 border-red-500/20";
    case "cancelled":
      return "bg-zinc-500/10 text-zinc-500 border-zinc-500/20";
    case "pending":
      return "bg-amber-500/10 text-amber-600 border-amber-500/20";
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

export function collapseLatestToolResults(
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
