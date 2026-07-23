/**
 * Shared link-daemon types.
 *
 * `ClusterConnectionHandle` is the transport-neutral lifecycle handle returned
 * by the daemon's cluster connection. The tunnel connection and `index.ts`
 * depend on this shape without depending on each other's implementation.
 */
export interface ClusterConnectionHandle {
  /** Trigger an orderly shutdown (no reconnect). */
  close(): Promise<void>;
  /** Resolves when the connection is permanently closed (e.g., 4001 or `close()`). */
  closed: Promise<void>;
}
