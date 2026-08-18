import type { TaskBoardItemThread } from "./config";

/**
 * What a task has cost, summed over the runs that recorded usage.
 *
 * `runCount` is the number of runs `total` actually sums — a thread with no
 * `finish` part yet (still running, or crashed before one) has `costUsd:
 * null` and is excluded, so it must not inflate the count either.
 */
export function summarizeTaskCost(
  threads: TaskBoardItemThread[] | undefined,
): { total: number; runCount: number } | null {
  const priced = (threads ?? []).filter((thread) => thread.costUsd !== null);
  if (priced.length === 0) return null;
  return {
    total: priced.reduce((sum, thread) => sum + (thread.costUsd ?? 0), 0),
    runCount: priced.length,
  };
}
