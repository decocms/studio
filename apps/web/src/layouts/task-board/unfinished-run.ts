/**
 * Whether a card still has a run in flight — the predicate the re-run
 * confirmation and its test both read.
 *
 * Pure and on its own so a test of it does not have to import the dialog, which
 * pulls Radix (and therefore a DOM) in with it.
 *
 * Mirrors the API's `TERMINAL_THREAD_STATUSES` — inlined rather than imported,
 * since `apps/web` must not reach into `apps/api/src`, and the two drifting
 * apart would mean the dialog promises something the tool does not do.
 */

import type { TaskBoardItem } from "./config";

const TERMINAL_THREAD_STATUSES = new Set(["completed", "failed", "expired"]);

export function hasUnfinishedRun(item: TaskBoardItem): boolean {
  return item.threads.some(
    (thread) =>
      thread.status !== null && !TERMINAL_THREAD_STATUSES.has(thread.status),
  );
}
