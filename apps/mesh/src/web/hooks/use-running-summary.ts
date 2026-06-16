/**
 * useRunningSummary — live "X agents working on N tasks" for an org.
 *
 * The server is authoritative: `/watch` emits a `decopilot.running.summary`
 * snapshot on connect (and re-emits on reconnect), and the run reactor
 * broadcasts a fresh summary through the SSE hub on every thread transition. So
 * the client just stores the latest summary it receives — no delta bookkeeping.
 *
 * State lives in a module-level, ref-counted store keyed by orgSlug so every
 * call-site shares one value and the single pooled `/watch` connection.
 */

import {
  DECOPILOT_RUNNING_SUMMARY_EVENT,
  type DecopilotRunningSummaryEvent,
  type RunningSummary,
} from "@decocms/mesh-sdk";
import { useSyncExternalStore } from "react";
import { Store } from "@/web/components/chat/store/store-primitive";
import { decopilotSSE } from "./decopilot-sse-pool";

const EMPTY: RunningSummary = Object.freeze({
  totalRunning: 0,
  agentCount: 0,
  agents: [],
});

interface SummaryEntry {
  store: Store<RunningSummary>;
  sseRefCount: number;
  sseUnsub: (() => void) | null;
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => RunningSummary;
}

const entries = new Map<string, SummaryEntry>();

function createEntry(orgSlug: string): SummaryEntry {
  const store = new Store<RunningSummary>(EMPTY);

  const handleMessage = (e: MessageEvent): void => {
    let event: DecopilotRunningSummaryEvent;
    try {
      event = JSON.parse(e.data);
    } catch {
      return;
    }
    if (event.type !== DECOPILOT_RUNNING_SUMMARY_EVENT) return;
    store.set(event.data.summary);
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
        entry.sseUnsub = decopilotSSE.subscribe(orgSlug, handleMessage);
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
 * Live running-thread summary for an org. Returns zeros until the connect
 * snapshot lands.
 */
export function useRunningSummary(orgSlug: string): RunningSummary {
  const entry = getEntry(orgSlug);
  return useSyncExternalStore(
    entry.subscribe,
    entry.getSnapshot,
    entry.getSnapshot,
  );
}
