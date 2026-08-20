import type { TaskBoardItemThread } from "./config";

/** The provider id a run reports when it authenticated with a linked Claude
 *  plan over OAuth, rather than with metered API credit. */
const CLAUDE_SUBSCRIPTION_PROVIDER = "claude-subscription";

/**
 * What a task has cost, summed over the runs that recorded usage.
 *
 * `runCount` is the number of runs `total` actually sums — a thread with no
 * `finish` part yet (still running, or crashed before one) has `costUsd:
 * null` and is excluded, so it must not inflate the count either.
 *
 * `onSubscription` is only true when EVERY priced run billed a linked Claude
 * plan. It drives a claim about whose money paid, so one run of unknown or
 * metered provenance has to sink it.
 */
export function summarizeTaskCost(
  threads: TaskBoardItemThread[] | undefined,
): { total: number; runCount: number; onSubscription: boolean } | null {
  const priced = (threads ?? []).filter((thread) => thread.costUsd !== null);
  if (priced.length === 0) return null;
  return {
    total: priced.reduce((sum, thread) => sum + (thread.costUsd ?? 0), 0),
    runCount: priced.length,
    onSubscription: priced.every(
      (thread) => thread.costProvider === CLAUDE_SUBSCRIPTION_PROVIDER,
    ),
  };
}
