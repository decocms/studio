/**
 * Loop-prevention + agent-scope guard for the observational sweep.
 *
 * Pure so it can be unit-tested and re-applied at dispatch time as a defense
 * against config drift between thread selection and the actual observer fire.
 * The time-based (idle) and DB-state (hidden, trigger, watermark) conditions
 * live in the SQL query (listObservableThreads); this covers exactly the
 * agent-identity rules, which are the safety-critical ones (a mistake here
 * lets the observer observe its own output and loop).
 */

export interface ObservabilityGuard {
  /** The observer agent itself — never observe its own threads. */
  observerAgentId: string;
  /** "all" observes every agent except scopeAgentIds; "only" observes just them. */
  scopeMode: "all" | "only";
  /** Excluded agents when scopeMode is "all"; the allowlist when "only". */
  scopeAgentIds: string[];
}

export function isObservable(
  thread: { virtual_mcp_id: string },
  guard: ObservabilityGuard,
): boolean {
  const agentId = thread.virtual_mcp_id;
  if (!agentId) return false;
  // The observer can never observe its own threads (loop prevention), even if
  // it somehow appears in an "only" allowlist.
  if (agentId === guard.observerAgentId) return false;
  return guard.scopeMode === "only"
    ? guard.scopeAgentIds.includes(agentId)
    : !guard.scopeAgentIds.includes(agentId);
}
