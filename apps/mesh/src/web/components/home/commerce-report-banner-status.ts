/**
 * Pure derivation of the home report banner state from `get_my_diagnostic`
 * (Commerce Discovery's owner view). Kept UI-free so the truth table is
 * unit-testable.
 *
 * The tool is the single source of truth for run state:
 * - `run_in_progress` is computed server-side (run_started_at > last_run_at,
 *   with a staleness cap) and means "the client must stay in the generating
 *   state" (see commerce-skills api/diagnostic/public-view.ts).
 * - `scanned_at` (= last_run_at) non-null means a completed deck exists.
 *
 * Anything else (no diagnostic, a claimed-but-never-run store, a stale/failed
 * run) derives to "none" so the banner never promises a report it can't show.
 */

export interface CommerceDiagnosticRunState {
  scanned_at?: string | null;
  run_in_progress?: boolean;
}

export type CommerceReportBannerStatus = "generating" | "ready" | "none";

export function deriveCommerceReportBannerStatus(
  diagnostic: CommerceDiagnosticRunState | null | undefined,
): CommerceReportBannerStatus {
  if (!diagnostic) return "none";
  if (diagnostic.run_in_progress) return "generating";
  if (diagnostic.scanned_at) return "ready";
  return "none";
}
