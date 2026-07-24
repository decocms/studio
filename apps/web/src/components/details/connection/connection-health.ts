import type { MonitoringLog } from "@/components/monitoring/monitoring-stats-row.tsx";

export interface TopError {
  message: string;
  count: number;
}

/**
 * Group a connection's failed calls by error message, most frequent first.
 * This is the "what is actually failing" signal the owner needs — a raw error
 * rate says a connection is broken; the top error says why.
 *
 * ponytail: computed over the already-fetched log sample (MONITORING_LOGS_LIST
 * caps at 1000 rows), so for very high-volume connections the counts are a
 * recent sample, not the full window — the error identity stays accurate. If
 * exact window-wide counts are needed, upgrade to a server-side
 * `GROUP BY error_message` query.
 */
export function computeTopErrors(logs: MonitoringLog[], limit = 3): TopError[] {
  const counts = new Map<string, number>();
  for (const log of logs) {
    if (!log.isError) continue;
    const message = (log.errorMessage ?? "").trim() || "Unknown error";
    counts.set(message, (counts.get(message) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
