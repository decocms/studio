/**
 * Shared link-daemon types.
 *
 * `ClusterConnectionHandle` is the transport-neutral lifecycle handle returned
 * by the daemon's cluster connection. It originally lived in the now-deleted WS
 * `cluster-connection.ts`; it was moved here (Phase C-bis S8) so the surviving
 * pull entry point (`cluster-connection-pull.ts`) and `index.ts` can depend on
 * the shape without the deleted WS module.
 */
export interface ClusterConnectionHandle {
  /** Trigger an orderly shutdown (no reconnect). */
  close(): Promise<void>;
  /** Resolves when the connection is permanently closed (e.g., 4001 or `close()`). */
  closed: Promise<void>;
}
