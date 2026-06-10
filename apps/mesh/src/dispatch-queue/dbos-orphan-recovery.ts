/**
 * Cancels DBOS workflows orphaned by pod death. DBOS's launch recovery only
 * reclaims its OWN executorID (= pod name), so a dead pod's workflows are never
 * picked up by the replacement (new name + new version) and sit non-terminal
 * forever — pinning queue slots. Fatal for the thread-gate queue (partition
 * concurrency=1): one stuck row freezes that thread.
 *
 * Cancel, don't resume: the thread-gate dispatch step is `retriesAllowed:false`
 * (thread-gate-workflow.ts) — an interrupted run is meant to fail cleanly, and
 * the user-facing run is separately resumed/failed by run-registry recovery.
 *
 * Two safe signals, by status:
 *   - PENDING (has `executorId`) → orphaned iff executor ∉ live-pod set. Version
 *     is unsafe here — a draining old-version pod is still running its PENDING.
 *   - ENQUEUED (no `executorId` yet) → orphaned iff `applicationVersion` drifted.
 *     A current-version ENQUEUED row is legitimately awaiting a live dequeuer.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";

const LIST_LIMIT = 1000;

async function cancelAll(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  await DBOS.cancelWorkflows(ids);
  return ids.length;
}

/**
 * Cancel ENQUEUED workflows whose `applicationVersion` no live executor runs.
 * Safe regardless of pod liveness (ENQUEUED = not yet started, nothing is
 * mid-flight). Covers every workflow name — a drifted ENQUEUED thread-gate row
 * would otherwise pin its thread's partition slot forever.
 */
async function cancelVersionDriftedEnqueued(): Promise<number> {
  const rows = await DBOS.listWorkflows({
    status: ["ENQUEUED"],
    loadInput: false,
    loadOutput: false,
    limit: LIST_LIMIT,
  });
  const stale = rows
    .filter((w) => w.applicationVersion !== DBOS.applicationVersion)
    .map((w) => w.workflowID);
  return cancelAll(stale);
}

/**
 * Cancel PENDING workflows owned by an executor that is no longer heartbeating.
 * `alivePods` MUST be trustworthy and include this pod — callers verify that
 * before invoking (an empty/self-missing set means the heartbeat isn't ready,
 * in which case classifying any executor as dead would be unsafe).
 */
async function cancelDeadExecutorPending(
  alivePods: ReadonlySet<string>,
): Promise<number> {
  const rows = await DBOS.listWorkflows({
    status: ["PENDING"],
    loadInput: false,
    loadOutput: false,
    limit: LIST_LIMIT,
  });
  const dead = rows
    .filter((w) => w.executorId != null && !alivePods.has(w.executorId))
    .map((w) => w.workflowID);
  return cancelAll(dead);
}

/**
 * Cancel a single dead pod's still-running (PENDING) workflows. Driven by the
 * heartbeat's `onPodDeath`, which fires the moment a pod's key expires/deletes
 * — by then the executor is confirmed gone, so cancellation can't interrupt a
 * live run.
 */
export async function cancelDeadPodWorkflows(
  deadPodId: string,
): Promise<number> {
  const rows = await DBOS.listWorkflows({
    status: ["PENDING"],
    executorId: deadPodId,
    loadInput: false,
    loadOutput: false,
    limit: LIST_LIMIT,
  });
  const n = await cancelAll(rows.map((w) => w.workflowID));
  if (n > 0) {
    console.log(
      `[dbos-recovery] cancelled ${n} PENDING workflow(s) from dead pod ${deadPodId}`,
    );
  }
  return n;
}

interface SweepResult {
  deadExecutor: number;
  versionDrift: number;
}

/**
 * Boot-time safety net for orphans the `onPodDeath` event missed — a hard
 * crash with no graceful KV delete, or a full simultaneous restart where no
 * pod was watching at TTL expiry. Mirrors `runRegistry.recoverOrphanedRuns`;
 * run it behind the same post-deploy grace window.
 *
 * The version-drift pass always runs (no liveness needed). The dead-executor
 * pass runs only when `alivePods` is trustworthy (non-empty and contains
 * `selfPodId`); otherwise it is skipped to avoid mis-classifying live runs.
 */
export async function sweepOrphanedWorkflows(
  alivePods: ReadonlySet<string>,
  selfPodId: string,
): Promise<SweepResult> {
  const versionDrift = await cancelVersionDriftedEnqueued();

  let deadExecutor = 0;
  if (alivePods.has(selfPodId)) {
    deadExecutor = await cancelDeadExecutorPending(alivePods);
  } else {
    console.warn(
      "[dbos-recovery] live-pod set unavailable or missing self; skipping dead-executor PENDING sweep",
    );
  }

  if (deadExecutor > 0 || versionDrift > 0) {
    console.log(
      `[dbos-recovery] boot sweep cancelled ${deadExecutor} dead-executor PENDING + ${versionDrift} version-drifted ENQUEUED workflow(s)`,
    );
  }
  return { deadExecutor, versionDrift };
}
