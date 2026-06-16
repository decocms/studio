/**
 * useRunningSummary — live running-thread state for an org, powering the home
 * "X agents working on N tasks" badge and its hover list.
 *
 * The server is authoritative: `/watch` emits a `decopilot.running.summary`
 * snapshot on connect (and re-emits on reconnect), and the run reactor
 * broadcasts a fresh one through the SSE hub on every thread transition. So the
 * client just stores the latest payload it receives — no delta bookkeeping.
 *
 * State lives in a module-level, ref-counted store keyed by orgSlug so every
 * call-site shares one value and one dedicated `/watch` connection.
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

/**
 * Dedicated `/watch` connection for the running summary — NOT the shared
 * decopilot pool. The summary's authoritative value arrives as the connect
 * snapshot (and on reconnect); a late subscriber joining the already-open
 * shared pool would miss that one-shot snapshot and sit at 0 until the next
 * transition. A dedicated, ref-counted connection guarantees every mount gets a
 * fresh snapshot. Filtered to just the summary type so it's a thin stream.
 */
const runningSummarySSE = createSSESubscription({
  buildUrl: (orgSlug) =>
    `/api/${encodeURIComponent(orgSlug)}/watch?types=${DECOPILOT_RUNNING_SUMMARY_EVENT}`,
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

function createEntry(orgSlug: string): SummaryEntry {
  const store = new Store<RunningState>(EMPTY);

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
        entry.sseUnsub = runningSummarySSE.subscribe(orgSlug, handleMessage);
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

function getEntry(orgSlug: string): SummaryEntry {
  let entry = entries.get(orgSlug);
  if (!entry) {
    entry = createEntry(orgSlug);
    entries.set(orgSlug, entry);
  }
  return entry;
}

/**
 * Live running-thread state for an org: the summary counts plus the per-thread
 * list (for the hover popover). Returns empties until the connect snapshot lands.
 */
export function useRunningSummary(orgSlug: string): RunningState {
  const entry = getEntry(orgSlug);
  return useSyncExternalStore(
    entry.subscribe,
    entry.getSnapshot,
    entry.getSnapshot,
  );
}
