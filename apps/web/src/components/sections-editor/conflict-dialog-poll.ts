/**
 * While a same-field conflict dialog is open, the editor reads the stored
 * blocks again every few seconds, so "their version" refreshes in place when
 * the other person saves again (SectionsEditor re-plans the waiting choice on
 * render whenever it holds a newer copy, keeping the picks whose two versions
 * didn't change, and the dialog says "Their version changed again…").
 *
 * One poll for the editor, however many fields or waiting saves: it starts
 * when a dialog opens and stops when the last one closes. The read is the
 * editor's own (the caller passes it); a tick is skipped while a read it
 * started is still running, while the caller says so (a write on the wire, a
 * read that just landed), and while the tab is hidden. After
 * {@link CONFLICT_DIALOG_POLL_FAST_FOR_MS} open, it slows to
 * {@link CONFLICT_DIALOG_POLL_SLOW_MS}: a dialog left open isn't worth a
 * provider request every few seconds.
 */

import { useRef, useState, useSyncExternalStore } from "react";

export const CONFLICT_DIALOG_POLL_MS = 3_000;
export const CONFLICT_DIALOG_POLL_SLOW_MS = 15_000;
export const CONFLICT_DIALOG_POLL_FAST_FOR_MS = 2 * 60_000;

export interface StoredBlocksPoll {
  /** Reads the stored blocks again, as the editor reads them. */
  read: () => Promise<unknown> | void;
  /** True to let this tick go by (a write on the wire, a read that just landed). */
  skip?: () => boolean;
}

export interface PollClock {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  hidden: () => boolean;
}

const realClock: PollClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
  hidden: () =>
    typeof document !== "undefined" && document.visibilityState === "hidden",
};

/** The wait before the next read, `openForMs` after the dialog opened. */
export function conflictPollDelay(openForMs: number): number {
  return openForMs < CONFLICT_DIALOG_POLL_FAST_FOR_MS
    ? CONFLICT_DIALOG_POLL_MS
    : CONFLICT_DIALOG_POLL_SLOW_MS;
}

/**
 * Starts the poll; the returned function stops it. `poll()` is asked on every
 * tick, so the caller can hand in its latest read without restarting.
 */
export function startConflictDialogPoll(
  poll: () => StoredBlocksPoll,
  clock: PollClock = realClock,
): () => void {
  const openedAt = clock.now();
  let stopped = false;
  let reading = false;
  let timer: unknown = null;
  const schedule = () => {
    if (stopped) return;
    timer = clock.setTimeout(tick, conflictPollDelay(clock.now() - openedAt));
  };
  const tick = () => {
    timer = null;
    if (stopped) return;
    const { read, skip } = poll();
    if (reading || clock.hidden() || skip?.()) {
      schedule();
      return;
    }
    reading = true;
    let pending: Promise<unknown> | void;
    try {
      pending = read();
    } catch {
      pending = undefined;
    }
    Promise.resolve(pending)
      .catch(() => {})
      .finally(() => {
        reading = false;
      });
    schedule();
  };
  schedule();
  return () => {
    stopped = true;
    if (timer !== null) clock.clearTimeout(timer);
  };
}

const getSnapshot = () => 0;

/** Polls the stored blocks while `open` (see the module comment). */
export function useConflictDialogPoll(
  open: boolean,
  poll: StoredBlocksPoll,
  clock: PollClock = realClock,
): void {
  const pollRef = useRef(poll);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- the running poll reads the latest read without restarting its timer
  pollRef.current = poll;
  // Two stable subscriptions: switching between them is what starts and
  // stops the timer (useSyncExternalStore resubscribes on a new function).
  const [subscriptions] = useState(() => ({
    polling: () => startConflictDialogPoll(() => pollRef.current, clock),
    idle: () => () => {},
  }));
  useSyncExternalStore(
    open ? subscriptions.polling : subscriptions.idle,
    getSnapshot,
    getSnapshot,
  );
}
