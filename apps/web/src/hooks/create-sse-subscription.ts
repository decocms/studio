/**
 * Shared SSE subscription factory. Within a tab, subscribers for the same key
 * share one ref-counted EventSource. With `crossTab`, exactly one tab per key
 * holds the real EventSource (leader, elected via a Web Lock) and rebroadcasts
 * events over a BroadcastChannel — so the whole browser stays under the ~6
 * connections-per-origin HTTP/1.1 cap. Same-origin tabs share cookies (same
 * user), so keying by org slug is safe.
 */

import { exponentialBackoffWithJitter } from "@decocms/shared/std";

const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

type Handler = (e: MessageEvent) => void;

type ChannelMessage =
  | { kind: "event"; type: string; data: string }
  | { kind: "reconnect" };

interface SharedConnection {
  key: string;
  refCount: number;
  handlers: Set<Handler>;
  /** Per-subscriber callbacks fired after a re-establishment (not initial open). */
  reconnectHandlers: Set<() => void>;
  /** First open is initial connect; a later open is a re-establishment. */
  bootDone: boolean;

  es: EventSource | null;
  isLeader: boolean;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;

  channel: BroadcastChannel | null;
  /** Aborts a pending Web Lock request on teardown. */
  lockAbort: AbortController | null;
  /** Resolving this frees the held Web Lock (relinquishes leadership). */
  releaseLeadership: (() => void) | null;
}

export interface SSESubscriptionOptions {
  buildUrl: (key: string) => string;
  eventTypes: string[];
  /** Web Lock + BroadcastChannel namespace; required when `crossTab` is on. */
  name?: string;
  /** Share one EventSource across same-origin tabs; falls back to per-tab when unsupported. */
  crossTab?: boolean;
}

export interface SSESubscription {
  /**
   * Subscribe to SSE events for the given key; returns an unsubscribe function.
   * `onReconnect` fires after each re-establishment (drop or leadership
   * hand-off), never on the first connect — subscribers do their own initial load.
   */
  subscribe: (
    key: string,
    handler: Handler,
    onReconnect?: () => void,
  ) => () => void;
}

export function createSSESubscription(
  options: SSESubscriptionOptions,
): SSESubscription {
  const { buildUrl, eventTypes, name, crossTab = false } = options;
  const connections = new Map<string, SharedConnection>();

  const supportsCrossTab =
    crossTab &&
    typeof BroadcastChannel !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.locks !== "undefined";

  if (supportsCrossTab && !name) {
    throw new Error("createSSESubscription: `name` is required when crossTab");
  }

  function deliver(conn: SharedConnection, ev: MessageEvent): void {
    conn.bootDone = true;
    for (const handler of conn.handlers) {
      try {
        handler(ev);
      } catch {
        // a misbehaving subscriber must not break fan-out
      }
    }
  }

  /** Fire local onReconnect callbacks (after a drop / leadership hand-off). */
  function fireReconnect(conn: SharedConnection): void {
    for (const cb of conn.reconnectHandlers) {
      try {
        cb();
      } catch {
        // ignore
      }
    }
  }

  function createEventSource(conn: SharedConnection): void {
    const es = new EventSource(buildUrl(conn.key));
    conn.es = es;

    es.onopen = () => {
      conn.reconnectAttempt = 0;
      // Re-establishment (network blip / leadership promotion); skip initial connect.
      if (conn.bootDone) {
        fireReconnect(conn);
        conn.channel?.postMessage({
          kind: "reconnect",
        } satisfies ChannelMessage);
      }
      conn.bootDone = true;
    };

    es.onerror = () => {
      if (conn.es === es && es.readyState === EventSource.CLOSED) {
        scheduleReconnect(conn);
      }
    };

    const relay: Handler = (e) => {
      conn.channel?.postMessage({
        kind: "event",
        type: e.type,
        data: e.data,
      } satisfies ChannelMessage);
      deliver(conn, e);
    };

    for (const type of eventTypes) es.addEventListener(type, relay);
  }

  function scheduleReconnect(conn: SharedConnection): void {
    if (conn.refCount <= 0 || conn.reconnectTimer) return;

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
      if (conn.refCount <= 0 || !conn.isLeader) return;
      conn.es?.close();
      createEventSource(conn);
    }, delay);
  }

  function becomeLeader(conn: SharedConnection): void {
    if (conn.refCount <= 0) {
      conn.releaseLeadership?.();
      conn.releaseLeadership = null;
      return;
    }
    conn.isLeader = true;
    createEventSource(conn);
  }

  function requestLeadership(conn: SharedConnection): void {
    if (!supportsCrossTab) {
      becomeLeader(conn);
      return;
    }
    conn.lockAbort = new AbortController();
    navigator.locks
      .request(
        `sse-leader:${name}:${conn.key}`,
        { signal: conn.lockAbort.signal },
        () =>
          new Promise<void>((resolve) => {
            conn.releaseLeadership = resolve;
            becomeLeader(conn);
          }),
      )
      .catch(() => {
        // AbortError on teardown, or transient lock errors — nothing to do.
      });
  }

  function handleChannelMessage(
    conn: SharedConnection,
    msg: ChannelMessage,
  ): void {
    if (msg.kind === "event") {
      deliver(conn, new MessageEvent(msg.type, { data: msg.data }));
    } else if (msg.kind === "reconnect") {
      fireReconnect(conn);
    }
  }

  function getOrCreate(key: string): SharedConnection {
    const existing = connections.get(key);
    if (existing) return existing;

    const conn: SharedConnection = {
      key,
      refCount: 0,
      handlers: new Set(),
      reconnectHandlers: new Set(),
      bootDone: false,
      es: null,
      isLeader: false,
      reconnectAttempt: 0,
      reconnectTimer: null,
      channel: null,
      lockAbort: null,
      releaseLeadership: null,
    };
    connections.set(key, conn);

    if (supportsCrossTab) {
      const channel = new BroadcastChannel(`sse:${name}:${key}`);
      channel.onmessage = (e) =>
        handleChannelMessage(conn, e.data as ChannelMessage);
      conn.channel = channel;
    }

    return conn;
  }

  function teardown(conn: SharedConnection): void {
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    conn.es?.close();
    conn.es = null;
    conn.releaseLeadership?.(); // free the lock if we hold leadership
    conn.releaseLeadership = null;
    conn.lockAbort?.abort(); // cancel a pending lock request if following
    conn.lockAbort = null;
    conn.channel?.close();
    conn.channel = null;
    connections.delete(conn.key);
  }

  // HMR: release locks / channels so a dev reload doesn't orphan the Web Lock.
  const hot = (
    import.meta as unknown as { hot?: { dispose: (cb: () => void) => void } }
  ).hot;
  if (hot) {
    hot.dispose(() => {
      for (const conn of [...connections.values()]) teardown(conn);
    });
  }

  return {
    subscribe(key, handler, onReconnect) {
      const isNew = !connections.has(key);
      const conn = getOrCreate(key);
      conn.refCount++;
      conn.handlers.add(handler);
      if (onReconnect) conn.reconnectHandlers.add(onReconnect);
      // Leadership is requested only after refCount reflects this subscriber —
      // the non-crossTab path elects synchronously, and becomeLeader bails
      // when refCount is still 0.
      if (isNew) requestLeadership(conn);

      let unsubscribed = false;
      return () => {
        if (unsubscribed) return;
        unsubscribed = true;

        conn.handlers.delete(handler);
        if (onReconnect) conn.reconnectHandlers.delete(onReconnect);
        conn.refCount--;
        if (conn.refCount <= 0) teardown(conn);
      };
    },
  };
}

/** View over a shared subscription that delivers only the given event types. */
export function filterEventTypes(
  base: SSESubscription,
  types: string[],
): SSESubscription {
  const allow = new Set(types);
  return {
    subscribe(key, handler, onReconnect) {
      const wrapped: Handler = (e) => {
        if (allow.has(e.type)) handler(e);
      };
      return base.subscribe(key, wrapped, onReconnect);
    },
  };
}
