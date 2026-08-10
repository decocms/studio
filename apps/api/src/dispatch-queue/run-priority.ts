/**
 * Which run gets the next slot when a pod is at its cap.
 *
 * Admission used to be first-come-first-served, which is the wrong order for a
 * board: a brand-new task takes a slot while the card ahead of it is In Review
 * waiting for a reviewer that can't get one. Nothing finishes, everything is
 * half-done, and every unfinished card is holding a PR nobody has ruled on.
 *
 * So the ordering is "finish before you start":
 *
 *   interactive  — a human is watching this stream. Always first.
 *   reviewer     — a QA / code-review run. The card is one verdict from Done.
 *   retry        — a re-dispatch of work that already failed once. It has a
 *                  budget; spending it behind new work wastes it.
 *   new task     — the only class where nothing is waiting on the outcome yet.
 *
 * Deliberately NOT a hard precondition ("no new task while any card is In
 * Review"). That reads as stricter and is worse: three cards sat In Review for
 * 40 minutes with reviewers that couldn't get a pod, and a hard rule would have
 * frozen the whole board instead of just ordering it. Priority starves nothing
 * permanently — a new task waits behind in-flight work and then runs.
 *
 * Values are DBOS's convention (1..2^31-1, lower dequeues first) so the same
 * numbers can be handed to `enqueueOptions.priority` without a second scale.
 */

/** How a run was started — set in `runMetadata.runClass` at enqueue. */
export type RunClass = "interactive" | "reviewer" | "retry" | "new_task";

export const RUN_PRIORITY: Record<RunClass, number> = {
  interactive: 10,
  reviewer: 20,
  retry: 30,
  new_task: 40,
};

/** Metadata key carrying the class. A free-form `runMetadata` string, so adding
 *  it changes no schema and no DBOS step I/O. */
export const RUN_CLASS_METADATA_KEY = "runClass";

/**
 * The priority for a run, from its metadata. An unmarked run is interactive:
 * every dispatch that isn't a board-driven background run is a person waiting on
 * a stream, and defaulting those to the back of the queue would be a visible
 * regression. Pure — unit-tested.
 */
export function runPriority(
  runMetadata: Record<string, string> | undefined,
): number {
  const cls = runMetadata?.[RUN_CLASS_METADATA_KEY];
  return cls && cls in RUN_PRIORITY
    ? RUN_PRIORITY[cls as RunClass]
    : RUN_PRIORITY.interactive;
}
