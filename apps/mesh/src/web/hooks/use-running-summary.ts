/**
 * Live running-thread state for the home badge + hover list. The "org" and
 * "user" (cross-org) scopes both arrive over the unified `/watch` connection
 * (watch-sse-pool.ts). Store values persist across mount/unmount so a remount
 * paints the last known counts instead of flashing empty.
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
import { runningSummaryWatchView } from "./watch-sse-pool";

export type RunningScope = "org" | "user";

const runningSummarySSE = runningSummaryWatchView;

export interface RunningState {
  summary: RunningSummary;
  threads: RunningThread[];
}

const EMPTY: RunningState = Object.freeze({
  summary: { totalRunning: 0, agentCount: 0 },
  threads: [],
});

// Per-org store for the org scope; one global store for the (cross-org) user scope.
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
      // Keep store values (no reset) so a later remount shows last known counts.
    }
  };
}

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
