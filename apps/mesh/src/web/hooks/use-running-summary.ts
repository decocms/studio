/**
 * useRunningSummary — live running-thread state for the home badge + hover list.
 *
 * ONE dedicated, ref-counted `/watch` connection per tab carries BOTH scopes:
 *   - "org"  → this org's running threads (DECOPILOT_RUNNING_SUMMARY_EVENT)
 *   - "user" → your running threads across every org you belong to
 *     (DECOPILOT_USER_RUNNING_SUMMARY_EVENT, delivered over the same connection
 *      because the server also listens on the `user:<id>` channel)
 *
 * Keeping it to a single thin connection matters: browsers cap ~6 concurrent
 * connections per domain over HTTP/1.1, so multiple tabs each holding several
 * SSE streams would exhaust the pool and hang the app.
 *
 * The server is authoritative: each scope's snapshot arrives on connect (and on
 * reconnect), and the reactor broadcasts fresh ones on every transition. The
 * cached value is NOT cleared when the last subscriber leaves, so a remount
 * paints the last known counts immediately instead of flashing empty.
 */

import {
  DECOPILOT_RUNNING_SUMMARY_EVENT,
  DECOPILOT_USER_RUNNING_SUMMARY_EVENT,
  type DecopilotRunningSummaryEvent,
  type RunningSummary,
  type RunningThread,
} from "@decocms/mesh-sdk";
import { useSyncExternalStore } from "react";
import { Store } from "@/web/components/chat/store/store-primitive";
import { createSSESubscription } from "./create-sse-subscription";

export type RunningScope = "org" | "user";

const runningSummarySSE = createSSESubscription({
  buildUrl: (orgSlug) =>
    `/api/${encodeURIComponent(orgSlug)}/watch?types=${DECOPILOT_RUNNING_SUMMARY_EVENT},${DECOPILOT_USER_RUNNING_SUMMARY_EVENT}`,
  eventTypes: [
    DECOPILOT_RUNNING_SUMMARY_EVENT,
    DECOPILOT_USER_RUNNING_SUMMARY_EVENT,
  ],
});

export interface RunningState {
  summary: RunningSummary;
  threads: RunningThread[];
}

const EMPTY: RunningState = Object.freeze({
  summary: { totalRunning: 0, agentCount: 0 },
  threads: [],
});

// Per-org store for the org scope; a single global store for the user scope
// (it's cross-org). Values persist across mount/unmount to avoid empty flashes.
const orgStores = new Map<string, Store<RunningState>>();
const userStore = new Store<RunningState>(EMPTY);

function orgStore(orgSlug: string): Store<RunningState> {
  let s = orgStores.get(orgSlug);
  if (!s) {
    s = new Store<RunningState>(EMPTY);
    orgStores.set(orgSlug, s);
  }
  return s;
}

// One ref-counted SSE connection per org slug, feeding both stores.
interface Conn {
  refCount: number;
  unsub: (() => void) | null;
}
const conns = new Map<string, Conn>();

function acquireConnection(orgSlug: string): () => void {
  let conn = conns.get(orgSlug);
  if (!conn) {
    const store = orgStore(orgSlug);
    const handler = (e: MessageEvent): void => {
      let event: DecopilotRunningSummaryEvent;
      try {
        event = JSON.parse(e.data);
      } catch {
        return;
      }
      const next: RunningState = {
        summary: event.data.summary,
        threads: event.data.threads,
      };
      if (event.type === DECOPILOT_RUNNING_SUMMARY_EVENT) {
        store.set(next);
      } else if (event.type === DECOPILOT_USER_RUNNING_SUMMARY_EVENT) {
        userStore.set(next);
      }
    };
    conn = { refCount: 0, unsub: null };
    conns.set(orgSlug, conn);
    conn.unsub = runningSummarySSE.subscribe(orgSlug, handler);
  }
  conn.refCount++;
  return () => {
    conn.refCount--;
    if (conn.refCount <= 0) {
      conn.unsub?.();
      conns.delete(orgSlug);
      // Intentionally keep the store values (no reset) so a later remount shows
      // the last known counts immediately rather than flashing empty.
    }
  };
}

// Stable subscribe/getSnapshot per (scope, orgSlug) for useSyncExternalStore.
interface HookEntry {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => RunningState;
}
const hookEntries = new Map<string, HookEntry>();

function getHookEntry(orgSlug: string, scope: RunningScope): HookEntry {
  const key = `${scope}:${orgSlug}`;
  let entry = hookEntries.get(key);
  if (!entry) {
    const store = scope === "user" ? userStore : orgStore(orgSlug);
    entry = {
      getSnapshot: store.get,
      subscribe: (onChange) => {
        const release = acquireConnection(orgSlug);
        const off = store.subscribe(onChange);
        return () => {
          off();
          release();
        };
      },
    };
    hookEntries.set(key, entry);
  }
  return entry;
}

/**
 * Live running-thread state for the given scope. Both scopes share the org's
 * single `/watch` connection. Returns empties until the first snapshot lands.
 */
export function useRunningSummary(
  orgSlug: string,
  scope: RunningScope,
): RunningState {
  const entry = getHookEntry(orgSlug, scope);
  return useSyncExternalStore(
    entry.subscribe,
    entry.getSnapshot,
    entry.getSnapshot,
  );
}
