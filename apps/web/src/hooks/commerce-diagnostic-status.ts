/**
 * Pure derivation of Commerce Discovery diagnostic state from
 * `get_my_diagnostic` (Commerce Discovery's owner view). Kept UI-free so the
 * truth table is unit-testable. Shared by the home report banner and the
 * task-board paywall banner (see use-commerce-diagnostic.ts).
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
  /** Paywall state — true until the org buys the one-time unlock. The board
   *  paywall banner shows while this is true; it clears itself on payment.
   *  UI hint only, not an authorization boundary — actual enforcement is
   *  server-side (see commerce-skills). Never gate a privileged action on
   *  this value. */
  locked?: boolean;
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

export interface CommerceDiagnosticLoadingState {
  /** Gate 1 (the CD connection lookup) hasn't resolved yet. */
  connectionQueryPending: boolean;
  /** Gate 1 resolved and found a CD connection. */
  hasConnection: boolean;
  /**
   * Opening the CD MCP client (gate 2) failed permanently — e.g. the
   * connection was revoked or the network is down. With no client, the
   * diagnostic read never runs and would otherwise sit at its initial
   * "pending" state forever.
   */
  cdClientFailed: boolean;
  /** The diagnostic read (gate 2's query) hasn't resolved yet. */
  diagnosticQueryPending: boolean;
}

/**
 * Whether {@link useCommerceDiagnostic} should still report `isLoading`. A
 * failed gate-2 client open must resolve to "not loading" (diagnostic: null)
 * rather than leave callers stuck on a loading state that can never clear —
 * the diagnostic query stays disabled, and never fetching, once its client
 * dependency has errored out.
 */
export function isCommerceDiagnosticLoading(
  state: CommerceDiagnosticLoadingState,
): boolean {
  if (state.connectionQueryPending) return true;
  if (!state.hasConnection) return false;
  if (state.cdClientFailed) return false;
  return state.diagnosticQueryPending;
}
