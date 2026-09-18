/** Keep a provider mount key distinct from a persisted thread ID. */
export interface ThreadSessionIdentity {
  threadId: string | null;
  providerKey: string;
}

/**
 * Pure core of the thread session's identity.
 *
 * A destination route names no thread until one is opened, but the providers
 * below it still need a stable React `key` so a later switch remounts them.
 * Those are two different values: `providerKey` falls back to a client-side id
 * so the tree keeps its identity, while `threadId` stays `null` so nothing can
 * stream, fetch or report against a thread that does not exist.
 */
export function resolveThreadSessionIdentity(input: {
  routeThreadId: string | null;
  /** Client-side id, stable for the life of the mount. Never a thread. */
  fallbackKey: string;
}): ThreadSessionIdentity {
  return {
    threadId: input.routeThreadId,
    providerKey: input.routeThreadId ?? input.fallbackKey,
  };
}
