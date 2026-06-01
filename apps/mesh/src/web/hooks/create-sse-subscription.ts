/**
 * Shared SSE subscription factory
 *
 * Manages ref-counted EventSource connections so multiple React components
 * can subscribe to the same SSE endpoint without opening duplicate connections.
 *
 * Each call to `createSSESubscription` creates an independent connection pool
 * keyed by a caller-provided key (typically an orgId).
 *
 * Reconnection: When EventSource enters CLOSED state (server restart, network
 * change), the connection is automatically re-established with exponential
 * backoff (1s → 2s → 4s, capped at 30s). Existing event listeners are
 * re-attached to the new EventSource transparently, and any subscriber that
 * registered an `onReconnect` callback is invoked once the re-established
 * connection opens (initial connect does NOT fire `onReconnect`).
 */

import { exponentialBackoffWithJitter } from "@decocms/std";

/** Max reconnect delay in ms */
const MAX_RECONNECT_DELAY_MS = 30_000;
/** Base reconnect delay in ms */
const BASE_RECONNECT_DELAY_MS = 1_000;

interface SharedConnection {
  es: EventSource;
  refCount: number;
  /** Active handlers to re-attach after reconnect */
  handlers: Set<(e: MessageEvent) => void>;
  /** Per-subscriber callbacks fired after a re-establishment (not initial open). */
  reconnectHandlers: Set<() => void>;
  /** Current reconnect attempt (reset on successful open) */
  reconnectAttempt: number;
  /** Pending reconnect timer */
  reconnectTimer: ReturnType<typeof setTimeout> | null;
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
   *
   * @param onReconnect Optional. Fired once each time the underlying
   * EventSource is re-established after a drop. NOT fired on the first
   * successful connect — subscribers do their own initial load.
   */
  subscribe: (
    key: string,
    handler: (e: MessageEvent) => void,
    onReconnect?: () => void,
  ) => () => void;
}

export function createSSESubscription(
  options: SSESubscriptionOptions,
): SSESubscription {
  const { buildUrl, eventTypes } = options;
  const connections = new Map<string, SharedConnection>();

  function attachListeners(
    es: EventSource,
    handlers: Set<(e: MessageEvent) => void>,
  ): void {
    for (const type of eventTypes) {
      for (const handler of handlers) {
        es.addEventListener(type, handler);
      }
    }
  }

  function createEventSource(
    key: string,
    conn: SharedConnection,
    fireReconnect: boolean,
  ): void {
    const es = new EventSource(buildUrl(key));

    es.onopen = () => {
      conn.reconnectAttempt = 0;
      if (fireReconnect) {
        for (const cb of conn.reconnectHandlers) cb();
      }
    };

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        scheduleReconnect(key, conn);
      }
    };

    conn.es = es;
    attachListeners(es, conn.handlers);
  }

  function scheduleReconnect(key: string, conn: SharedConnection): void {
    if (conn.refCount <= 0) {
      connections.delete(key);
      return;
    }

    if (conn.reconnectTimer) return;

    const delay = exponentialBackoffWithJitter(
      MAX_RECONNECT_DELAY_MS,
      BASE_RECONNECT_DELAY_MS,
      conn.reconnectAttempt,
      2,
      0,
    );
    conn.reconnectAttempt++;

    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;

      if (conn.refCount <= 0) {
        connections.delete(key);
        return;
      }

      conn.es.close();
      createEventSource(key, conn, /* fireReconnect */ true);
    }, delay);
  }

  function getOrCreate(key: string): SharedConnection {
    let conn = connections.get(key);
    if (!conn) {
      conn = {
        es: null!,
        refCount: 0,
        handlers: new Set(),
        reconnectHandlers: new Set(),
        reconnectAttempt: 0,
        reconnectTimer: null,
      };
      createEventSource(key, conn, /* fireReconnect */ false);
      connections.set(key, conn);
    }
    return conn;
  }

  return {
    subscribe(key, handler, onReconnect) {
      const conn = getOrCreate(key);
      conn.refCount++;
      conn.handlers.add(handler);
      if (onReconnect) conn.reconnectHandlers.add(onReconnect);

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
        conn.handlers.delete(handler);
        if (onReconnect) conn.reconnectHandlers.delete(onReconnect);
        conn.refCount--;
        if (conn.refCount <= 0) {
          if (conn.reconnectTimer) {
            clearTimeout(conn.reconnectTimer);
          }
          conn.es.close();
          connections.delete(key);
        }
      };
    },
  };
}
