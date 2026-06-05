/**
 * Loop-prevention + skip-list guard for the observational sweep.
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
  /** Agent ids the admin configured the observer to ignore. */
  skipAgentIds: string[];
}

export function isObservable(
  thread: { virtual_mcp_id: string },
  guard: ObservabilityGuard,
): boolean {
  const agentId = thread.virtual_mcp_id;
  if (!agentId) return false;
  if (agentId === guard.observerAgentId) return false;
  if (guard.skipAgentIds.includes(agentId)) return false;
  return true;
}
