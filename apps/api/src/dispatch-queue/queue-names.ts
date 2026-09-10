/**
 * DBOS workflow-queue NAMES, isolated from the workflow modules that register
 * them. Those modules (`thread-gate-workflow`, `automations/dbos-workflow`)
 * run `DBOS.registerWorkflow` at import time, and `index.ts` documents that
 * `DBOS.setConfig` must run *before* any such registration. `setConfig` now
 * needs the queue names (for the `listenQueues` pod-role split), so they live
 * here — a side-effect-free module safe to import before `setConfig`.
 */
export const THREAD_GATE_QUEUE = "thread-gate";
/**
 * In-process hosted runs (a full agent loop on the dequeuing pod).
 *
 * Not partitioned, and capped per pod with `workerConcurrency` — DBOS enforces
 * that at DEQUEUE, which is the whole point. The cap used to be an in-process
 * gate that parked an over-cap run on the pod that had already claimed it;
 * nothing un-claims a PENDING workflow, so a saturated pod hoarded the backlog
 * while its siblings sat idle (prod 2026-08-19: 11 pending runs pinned to 2 of 5
 * pods, the other 3 at zero, and the KEDA scale-up that the parking itself
 * triggered had nothing left to hand the new pods). Over-cap work now stays
 * ENQUEUED for any pod, and `priorityEnabled` orders runs across the whole queue
 * instead of within one pod's park list.
 *
 * Partitioning is what made `workerConcurrency` unusable: DBOS counts it per
 * (queue, partition) and rejects it above `concurrency`, so on a concurrency=1
 * partitioned queue it can only mean "1 run of this one thread per pod". The
 * partition was redundant regardless — per-thread serialization belongs to the
 * parent gate (THREAD_GATE_QUEUE, concurrency=1 per threadId, whose consume step
 * outlives the child) and the run fence.
 */
export const HOSTED_HARNESS_QUEUE = "decopilot-hosted-harness";
/**
 * Sandboxed (`claude-code`) hosted runs. Same shape as `HOSTED_HARNESS_QUEUE`; a
 * separate queue only because `workerConcurrency` is one number per queue and
 * this class costs the pod a stream proxy rather than an agent loop, so it gets
 * a much higher cap. Sharing one cap let cheap sandboxed runs park a whole
 * board's worth of in-process work behind them.
 */
export const HOSTED_HARNESS_SANDBOXED_QUEUE =
  "decopilot-hosted-harness-sandboxed";
export const AUTOMATIONS_QUEUE = "automations";
export const BACKGROUND_TOOLS_QUEUE = "background-tools";
/** Rate-limited GitHub reads for the task board's review sweep. */
export const GITHUB_READS_QUEUE = "task-board-github-reads";
