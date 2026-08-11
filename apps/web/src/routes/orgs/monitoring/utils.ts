/**
 * Monitoring Dashboard Utilities
 *
 * Shared helpers, types, and constants used across monitoring tabs.
 */

import type { useConnections, useVirtualMCPs } from "@/sdk";
import { isDecopilot, getWellKnownDecopilotVirtualMCP } from "@/sdk";
import type { useMembers } from "@/hooks/use-members";
import type {
  DateRange,
  MonitoringStatsData,
} from "@/components/monitoring/monitoring-stats-row.tsx";

// Re-export for convenience
export type { DateRange, MonitoringStatsData };

// ── Grafana-style auto-interval ─────────────────────────────────────────────

const NICE_INTERVALS: Array<{ ms: number; label: string }> = [
  { ms: 60_000, label: "1m" },
  { ms: 120_000, label: "2m" },
  { ms: 300_000, label: "5m" },
  { ms: 600_000, label: "10m" },
  { ms: 900_000, label: "15m" },
  { ms: 1_800_000, label: "30m" },
  { ms: 3_600_000, label: "1h" },
  { ms: 7_200_000, label: "2h" },
  { ms: 21_600_000, label: "6h" },
  { ms: 43_200_000, label: "12h" },
  { ms: 86_400_000, label: "1d" },
  { ms: 604_800_000, label: "7d" },
];

const TARGET_STEPS = 40;

export function getIntervalFromRange(range: DateRange): string {
  const durationMs = range.endDate.getTime() - range.startDate.getTime();
  const rawInterval = durationMs / TARGET_STEPS;
  const nice = NICE_INTERVALS.find((b) => b.ms >= rawInterval);
  return nice?.label ?? "1d";
}

function intervalToMs(interval: string): number {
  const entry = NICE_INTERVALS.find((b) => b.label === interval);
  if (entry) return entry.ms;
  const match = /^(\d+)([mhd])$/.exec(interval);
  if (!match) return 60_000;
  const amount = parseInt(match[1]!, 10);
  const unit = match[2];
  if (unit === "h") return amount * 3_600_000;
  if (unit === "d") return amount * 86_400_000;
  return amount * 60_000;
}

function formatTimestampLabel(timestamp: string, interval: string): string {
  const date = new Date(timestamp);
  const ms = intervalToMs(interval);
  if (ms >= 86_400_000) {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function floorToInterval(date: Date, interval: string): Date {
  const ms = intervalToMs(interval);
  return new Date(Math.floor(date.getTime() / ms) * ms);
}

export function formatDuration(ms: number): string {
  if (ms >= 10000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/** Compact token/number formatting: 1234 → 1.2K, 1_500_000 → 1.5M. */
export function formatCompactNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toLocaleString();
}

/** USD cost formatting: sub-dollar gets 4 decimals, otherwise 2. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

/**
 * Build display-ready timeseries from server points.
 *
 * Generates one bucket per interval step across the range and places server
 * points directly into their matching bucket. Empty gaps are filled with
 * zeros.
 */
export function buildFilledStatsData(
  points: Array<{
    timestamp: string;
    calls: number;
    errors: number;
    errorRate: number;
    avg: number;
    p50: number;
    p95: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  }>,
  range: DateRange,
  interval: string,
): MonitoringStatsData["data"] {
  const stepMs = intervalToMs(interval);
  const startMs = floorToInterval(range.startDate, interval).getTime();
  const endMs = range.endDate.getTime();

  const pointMap = new Map(
    points.map((point) => [
      floorToInterval(new Date(point.timestamp), interval).getTime(),
      point,
    ]),
  );

  const data: MonitoringStatsData["data"] = [];
  for (let ts = startMs; ts <= endMs; ts += stepMs) {
    const point = pointMap.get(ts);
    const iso = new Date(ts).toISOString();
    data.push({
      t: iso,
      ts,
      label: formatTimestampLabel(iso, interval),
      calls: point?.calls ?? 0,
      errors: point?.errors ?? 0,
      errorRate: point?.errorRate ?? 0,
      avg: point?.avg ?? 0,
      p50: point?.p50 ?? 0,
      p95: point?.p95 ?? 0,
      inputTokens: point?.inputTokens ?? 0,
      outputTokens: point?.outputTokens ?? 0,
      totalTokens: point?.totalTokens ?? 0,
      costUsd: point?.costUsd ?? 0,
    });
  }

  return data;
}

// ── Tool-call heatmap ────────────────────────────────────────────────────────

export interface HeatmapCell {
  virtualMcpId: string | null;
  toolName: string;
  calls: number;
  errors: number;
  outputSize: number;
}

export interface HeatmapView {
  topTools: string[];
  topAgentIds: string[];
  cellMap: Map<string, { calls: number; errors: number; outputSize: number }>;
  /** Max cell value among the cells actually rendered (topAgentIds × topTools), for color scaling. */
  maxValue: number;
}

/**
 * Reduce raw heatmap cells to the top tools/agents to render, plus the max
 * value among the rendered cells (used to scale cell color intensity).
 * The max is computed only over cells that end up on screen — an agent with
 * a high single-tool spike but a low overall total gets excluded from
 * topAgentIds, and must not skew the color scale for the agents shown.
 */
export function computeHeatmapView(
  cells: HeatmapCell[],
  metric: "calls" | "outputSize",
  maxTools: number,
  maxAgents: number,
): HeatmapView {
  const toolTotals = new Map<string, number>();
  for (const cell of cells) {
    toolTotals.set(
      cell.toolName,
      (toolTotals.get(cell.toolName) ?? 0) + cell[metric],
    );
  }
  const topTools = [...toolTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTools)
    .map(([name]) => name);
  const toolSet = new Set(topTools);

  const agentTotals = new Map<string, number>();
  const cellMap = new Map<
    string,
    { calls: number; errors: number; outputSize: number }
  >();
  for (const cell of cells) {
    if (!toolSet.has(cell.toolName)) continue;
    const agentId = cell.virtualMcpId ?? "";
    agentTotals.set(agentId, (agentTotals.get(agentId) ?? 0) + cell[metric]);
    cellMap.set(`${agentId}::${cell.toolName}`, {
      calls: cell.calls,
      errors: cell.errors,
      outputSize: cell.outputSize,
    });
  }
  const topAgentIds = [...agentTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxAgents)
    .map(([id]) => id);

  let maxValue = 0;
  for (const agentId of topAgentIds) {
    for (const tool of topTools) {
      const cell = cellMap.get(`${agentId}::${tool}`);
      if (cell && cell[metric] > maxValue) maxValue = cell[metric];
    }
  }

  return { topTools, topAgentIds, cellMap, maxValue };
}

// ── Connection metrics ──────────────────────────────────────────────────────

export type ConnectionMetric = {
  connectionId: string;
  calls: number;
  errors: number;
  errorRate: number;
  avgDurationMs: number;
};

export type LeaderboardMode = "requests" | "errors" | "latency";

export function getMetricValue(
  m: ConnectionMetric,
  mode: LeaderboardMode,
): number {
  if (mode === "requests") return m.calls;
  if (mode === "errors") return m.errorRate;
  return m.avgDurationMs;
}

export function formatMetricValue(
  m: { calls: number; errorRate: number; avgDurationMs: number },
  mode: "requests" | "errors" | "latency",
): string {
  if (mode === "requests") return m.calls.toLocaleString();
  if (mode === "errors") return `${m.errorRate.toFixed(1)}%`;
  return formatDuration(m.avgDurationMs);
}

// ── Agent resolution helpers ────────────────────────────────────────────────

export function getThreadAgentId(thread: {
  run_config?: Record<string, unknown> | null;
  virtual_mcp_id?: string;
}): string | null {
  const runConfig = (thread.run_config ?? {}) as { agent?: { id: string } };
  return runConfig.agent?.id ?? (thread.virtual_mcp_id || null);
}

export function resolveAgentName(
  agentId: string | null,
  virtualMcps: ReturnType<typeof useVirtualMCPs>,
  connections: ReturnType<typeof useConnections>,
  fallback: string,
): string {
  if (!agentId) return fallback;
  const found =
    virtualMcps.find((v) => v.id === agentId) ??
    connections?.find((c) => c.id === agentId);
  if (found?.title) return found.title;
  const orgId = isDecopilot(agentId);
  if (orgId) return getWellKnownDecopilotVirtualMCP(orgId).title ?? fallback;
  return agentId;
}

export function resolveAgentIcon(
  agentId: string | null,
  virtualMcps: ReturnType<typeof useVirtualMCPs>,
  connections: ReturnType<typeof useConnections>,
): string | null {
  if (!agentId) return null;
  const found =
    virtualMcps.find((v) => v.id === agentId) ??
    connections?.find((c) => c.id === agentId);
  return found?.icon ?? null;
}

// ── Member helpers ──────────────────────────────────────────────────────────

export interface OrgMember {
  userId: string;
  user: { name?: string | null; email?: string | null; image?: string | null };
}

export function getOrgMembers(
  data: ReturnType<typeof useMembers>["data"] | undefined,
): OrgMember[] {
  return (data?.data?.members ?? []) as OrgMember[];
}

export interface ThreadUsageDisplay {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
