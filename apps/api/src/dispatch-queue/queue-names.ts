/**
 * DBOS workflow-queue NAMES, isolated from the workflow modules that register
 * them. Those modules (`thread-gate-workflow`, `automations/dbos-workflow`)
 * run `DBOS.registerWorkflow` at import time, and `index.ts` documents that
 * `DBOS.setConfig` must run *before* any such registration. `setConfig` now
 * needs the queue names (for the `listenQueues` pod-role split), so they live
 * here — a side-effect-free module safe to import before `setConfig`.
 */
export const THREAD_GATE_QUEUE = "thread-gate";
export const HOSTED_HARNESS_QUEUE = "decopilot-hosted-harness";
export const AUTOMATIONS_QUEUE = "automations";
export const BACKGROUND_TOOLS_QUEUE = "background-tools";
/** Rate-limited GitHub reads for the task board's review sweep. */
export const GITHUB_READS_QUEUE = "task-board-github-reads";
