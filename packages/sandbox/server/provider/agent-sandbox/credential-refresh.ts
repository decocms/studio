/**
 * Fan out a per-item credential refresh, grouped by connection.
 *
 * Refreshing an OAuth token rotates its refresh_token, so two concurrent
 * refreshes for the *same* connection race (the second uses a spent refresh
 * token and fails). Items sharing a connection id are therefore processed
 * sequentially — the first refresh mints, the rest see the token already fresh
 * and no-op — while distinct connections run in parallel. Items with no
 * connection id are skipped. Best-effort: one item's failure never blocks the
 * others — including later items *in the same connection's queue* — so
 * `refreshOne` should surface its own errors.
 */
export async function refreshCredentialsByConnection<T>(
  items: Iterable<T>,
  connectionIdOf: (item: T) => string | undefined,
  refreshOne: (item: T) => Promise<void>,
): Promise<void> {
  const byConnection = new Map<string, T[]>();
  for (const item of items) {
    const connectionId = connectionIdOf(item);
    if (!connectionId) continue;
    const group = byConnection.get(connectionId);
    if (group) group.push(item);
    else byConnection.set(connectionId, [item]);
  }
  await Promise.allSettled(
    [...byConnection.values()].map(async (group) => {
      for (const item of group) {
        // A throw here must not stop the rest of this connection's queue —
        // `refreshOne` is expected to log its own errors (see docstring).
        await refreshOne(item).catch(() => {});
      }
    }),
  );
}
