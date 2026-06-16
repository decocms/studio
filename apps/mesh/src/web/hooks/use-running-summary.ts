/**
 * useRunningSummary — live running-thread state for the home badge + hover list.
 *
 * Two scopes:
 *   - "org"  → the current org's running threads (`/api/:org/watch`), team view.
 *   - "user" → your own running threads across every org (`/api/me/watch`).
 *
 * The server is authoritative: each feed emits a `decopilot.running.summary`
 * snapshot on connect (and on reconnect), and the run reactor broadcasts a fresh
 * one on every thread transition (to the org channel and the creator's user
 * channel). The client just stores the latest payload — no delta bookkeeping.
 *
 * State lives in module-level, ref-counted stores keyed by `scope:key`, so every
 * call-site shares one value and one dedicated `/watch` connection per feed.
 */

import {
  DECOPILOT_RUNNING_SUMMARY_EVENT,
  type DecopilotRunningSummaryEvent,
  type RunningSummary,
  type RunningThread,
} from "@decocms/mesh-sdk";
import { useSyncExternalStore } from "react";
import { Store } from "@/web/components/chat/store/store-primitive";
import { createSSESubscription } from "./create-sse-subscription";

export type RunningScope = "org" | "user";

// Dedicated, ref-counted `/watch` connections (one per feed). NOT the shared
// decopilot pool: a late subscriber joining an already-open shared connection
// would miss the one-shot connect snapshot. Filtered to just the summary type.
const orgRunningSummarySSE = createSSESubscription({
  buildUrl: (orgSlug) =>
    `/api/${encodeURIComponent(orgSlug)}/watch?types=${DECOPILOT_RUNNING_SUMMARY_EVENT}`,
  eventTypes: [DECOPILOT_RUNNING_SUMMARY_EVENT],
});
const userRunningSummarySSE = createSSESubscription({
  buildUrl: () => `/api/me/watch?types=${DECOPILOT_RUNNING_SUMMARY_EVENT}`,
  eventTypes: [DECOPILOT_RUNNING_SUMMARY_EVENT],
});

export interface RunningState {
  summary: RunningSummary;
  threads: RunningThread[];
}

const EMPTY: RunningState = Object.freeze({
  summary: { totalRunning: 0, agentCount: 0 },
  threads: [],
});

interface SummaryEntry {
  store: Store<RunningState>;
  sseRefCount: number;
  sseUnsub: (() => void) | null;
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => RunningState;
}

const entries = new Map<string, SummaryEntry>();

function createEntry(scope: RunningScope, connKey: string): SummaryEntry {
  const store = new Store<RunningState>(EMPTY);
  const sse = scope === "user" ? userRunningSummarySSE : orgRunningSummarySSE;

  const handleMessage = (e: MessageEvent): void => {
    let event: DecopilotRunningSummaryEvent;
    try {
      event = JSON.parse(e.data);
    } catch {
      return;
    }
    if (event.type !== DECOPILOT_RUNNING_SUMMARY_EVENT) return;
    store.set({ summary: event.data.summary, threads: event.data.threads });
  };

  const entry: SummaryEntry = {
    store,
    sseRefCount: 0,
    sseUnsub: null,
    getSnapshot: store.get,
    subscribe: (onChange) => {
      const storeUnsub = store.subscribe(onChange);
      entry.sseRefCount++;
      if (entry.sseRefCount === 1) {
        entry.sseUnsub = sse.subscribe(connKey, handleMessage);
      }
      return () => {
        storeUnsub();
        entry.sseRefCount--;
        if (entry.sseRefCount === 0) {
          entry.sseUnsub?.();
          entry.sseUnsub = null;
          // Reset so a later remount re-seeds from the next connect snapshot.
          store.set(EMPTY);
        }
      };
    },
  };

  return entry;
}

function getEntry(scope: RunningScope, connKey: string): SummaryEntry {
  const mapKey = `${scope}:${connKey}`;
  let entry = entries.get(mapKey);
  if (!entry) {
    entry = createEntry(scope, connKey);
    entries.set(mapKey, entry);
  }
  return entry;
}

/**
 * Live running-thread state for the given scope. The org feed is keyed by
 * orgSlug; the user feed is a single per-session connection. Returns empties
 * until the connect snapshot lands.
 */
export function useRunningSummary(
  orgSlug: string,
  scope: RunningScope,
): RunningState {
  const entry = getEntry(scope, scope === "user" ? "me" : orgSlug);
  return useSyncExternalStore(
    entry.subscribe,
    entry.getSnapshot,
    entry.getSnapshot,
  );
}
