/**
 * Shared SSE subscription factory
 *
 * Manages ref-counted EventSource connections so multiple React components
 * can subscribe to the same SSE endpoint without opening duplicate connections.
 *
 * Each call to `createSSESubscription` creates an independent connection pool
 * keyed by a caller-provided key (typically an orgId).
 */

interface SharedConnection {
  es: EventSource;
  refCount: number;
}

export interface SSESubscriptionOptions {
  /** URL builder given a connection key */
  buildUrl: (key: string) => string;
  /** SSE event types to listen for */
  eventTypes: string[];
}

export interface SSESubscription {
  /**
   * Subscribe to SSE events for the given key.
   * Returns an unsubscribe function.
   *
   * Multiple subscribers share one EventSource per key; the connection
   * is closed when the last subscriber unsubscribes.
   */
  subscribe: (key: string, handler: (e: MessageEvent) => void) => () => void;
}

export function createSSESubscription(
  options: SSESubscriptionOptions,
): SSESubscription {
  const { buildUrl, eventTypes } = options;
  const connections = new Map<string, SharedConnection>();

  function getOrCreate(key: string): SharedConnection {
    let conn = connections.get(key);
    if (!conn) {
      const es = new EventSource(buildUrl(key));
      conn = { es, refCount: 0 };
      connections.set(key, conn);

      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          connections.delete(key);
        }
      };
    }
    return conn;
  }

  return {
    subscribe(key, handler) {
      const conn = getOrCreate(key);
      conn.refCount++;

      for (const type of eventTypes) {
        conn.es.addEventListener(type, handler);
      }

      let unsubscribed = false;
      return () => {
        if (unsubscribed) return;
        unsubscribed = true;

        for (const type of eventTypes) {
          conn.es.removeEventListener(type, handler);
        }
        conn.refCount--;
        if (conn.refCount <= 0) {
          conn.es.close();
          connections.delete(key);
        }
      };
    },
  };
}
