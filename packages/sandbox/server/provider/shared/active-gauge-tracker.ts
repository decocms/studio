/**
 * Tracks which sandbox handles actually contributed a +1 to the "active
 * sandboxes" gauge, so a teardown path doesn't have to guess whether it owes
 * a decrement.
 *
 * The gauge is only incremented on a fresh `ensure()` observation (see
 * `AgentSandboxProvider.finish`); a record can also enter the in-memory cache
 * via a read-only path (`getRecord` rehydrating from the state store) that
 * never increments it. Decrementing unconditionally on every teardown would
 * undercount for records the gauge never counted, and — the more common case
 * in practice — a record evicted by something other than an explicit
 * `delete()` call (idle-TTL claim reap, a stale port-forward, a 401) would
 * never decrement at all, since only `delete()` touched the gauge before this
 * tracker existed. Both drift the gauge away from the cluster's real count,
 * which is exactly the divergence this metric exists to surface.
 */
export class ActiveGaugeTracker {
  private readonly counted = new Set<string>();

  markCounted(handle: string): void {
    this.counted.add(handle);
  }

  /** True (and clears the entry) iff this handle owes a decrement. */
  consume(handle: string): boolean {
    return this.counted.delete(handle);
  }
}
