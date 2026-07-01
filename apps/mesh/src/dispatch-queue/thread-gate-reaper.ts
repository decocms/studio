/**
 * Cross-pod liveness reaper.
 *
 * Force-fails runs stuck `in_progress` whose progress has gone stale for longer
 * than REAPER_STUCK_TIMEOUT_MS. This is the safety net that makes Phase 2's
 * uncapped gate wait safe: with the 1 h poll cap removed, a gate waiting on a
 * dead daemon would poll forever unless something flips the run to a terminal
 * status — this reaper is that something.
 *
 * Distinct from the per-pod RunRegistry reaper (run-registry.ts), which only
 * sees runs in THIS pod's memory and so cannot reap a run orphaned by a crashed
 * pod. This one scans the DB across all orgs/pods. Both call the idempotent
 * forceFailIfInProgress, so they can run concurrently without conflict.
 *
 * Runtime deps (storage) are injected via a module-level registry, wired by app
 * boot through `setThreadGateReaperRuntime` BEFORE `DBOS.launch()` — same pattern
 * as setThreadGateRuntime / setProjectorWorkflowRuntime.
 */

import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";
import { meter } from "@/observability";

/**
 * 45 min. Must clear a long SINGLE tool call: a multi-minute bash build / slow
 * MCP tool / deep web-fetch emits no UI chunks while running, so
 * last_progress_at does not advance even though the run is healthy. Deliberately
 * longer than the per-pod RUN_IDLE_TIMEOUT_MS (10 min, run-registry.ts) — this
 * is a coarse cross-pod backstop, not the primary liveness mechanism.
 */
const REAPER_STUCK_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * 5 min. Grace after a gate's `dispatchRunAndWait` step COMPLETES before we
 * treat a still-`PENDING` gate as orphaned. Once dispatch returns, the only
 * remaining work is `consumeRunProjection` (reads the retained stream, writes
 * parts) — seconds, not minutes. A gate still PENDING minutes after its
 * dispatch completed means the executor driving it died (e.g. a deploy rolled
 * the worker pod) and DBOS's own recovery never re-adopted it — so it sits
 * forever, holding the per-thread queue slot and bricking the thread. This
 * grace is generously larger than any real projection so a live run that just
 * finished dispatching is never reaped mid-projection.
 */
const ORPHAN_GATE_GRACE_MS = 5 * 60 * 1000;

/** Every minute (crontab granularity floor). */
const REAPER_CRONTAB = "* * * * *";

export interface ThreadGateReaperRuntime {
  listStuckRuns(
    cutoffIso: string,
  ): Promise<Array<{ id: string; organizationId: string }>>;
  forceFailIfInProgress(id: string, organizationId: string): Promise<boolean>;
  /**
   * Cross-org scan for orphaned gate workflows: `threadGateWorkflow`s still
   * `PENDING` on the `thread-gate` queue whose `dispatchRunAndWait` step
   * completed before `dispatchCompletedBeforeMs`. Returns the DBOS workflow
   * ids to cancel. Reads `dbos.workflow_status` + `dbos.operation_outputs`.
   */
  listOrphanedGateWorkflows(
    dispatchCompletedBeforeMs: number,
  ): Promise<string[]>;
  /** Cancel a gate workflow (frees its per-thread queue partition slot). */
  cancelGateWorkflow(workflowId: string): Promise<void>;
}

let runtime: ThreadGateReaperRuntime | null = null;

export function setThreadGateReaperRuntime(rt: ThreadGateReaperRuntime): void {
  runtime = rt;
}

const reapedCounter = meter.createCounter("decopilot.gate.reaped", {
  description: "Runs force-failed by the cross-pod thread-gate reaper",
  unit: "{runs}",
});

const orphanedGateReapedCounter = meter.createCounter(
  "decopilot.gate.orphan_reaped",
  {
    description:
      "Orphaned gate workflows cancelled by the cross-pod reaper (dispatch done, executor dead)",
    unit: "{workflows}",
  },
);

/**
 * One sweep: find stuck runs as of `nowMs`, force-fail each, return how many
 * actually transitioned (forceFailIfInProgress is conditional on
 * status='in_progress', so a run already terminal counts 0). Pure w.r.t. the
 * injected runtime — unit/integration testable without DBOS.
 */
export async function reapStuckRunsSweep(
  rt: ThreadGateReaperRuntime,
  nowMs: number,
  idleTimeoutMs: number = REAPER_STUCK_TIMEOUT_MS,
): Promise<number> {
  const cutoffIso = new Date(nowMs - idleTimeoutMs).toISOString();
  const stuck = await rt.listStuckRuns(cutoffIso);
  let reaped = 0;
  for (const run of stuck) {
    const flipped = await rt.forceFailIfInProgress(run.id, run.organizationId);
    if (!flipped) continue;
    reaped++;
    reapedCounter.add(1);
    console.warn(
      JSON.stringify({
        msg: "thread-gate-reaper",
        event: "reaped",
        runId: run.id,
        orgId: run.organizationId,
        cutoffIso,
      }),
    );
  }
  return reaped;
}

/**
 * One sweep for orphaned gate workflows: cancel every `threadGateWorkflow`
 * whose `dispatchRunAndWait` completed before `nowMs - graceMs` yet is still
 * `PENDING`. Cancelling frees the per-thread queue partition slot so the
 * thread's ENQUEUED turns drain. Pure w.r.t. the injected runtime.
 *
 * Distinct from `reapStuckRunsSweep`, which targets the RUN (force-fails a run
 * whose progress stalled, so a gate WAITING in `dispatchRunAndWait` unblocks).
 * This one targets the WORKFLOW after `dispatchRunAndWait` already returned —
 * the run completed but its executor died before projecting, so nothing ever
 * flips the workflow terminal. The run reaper cannot see this (the run is not
 * `in_progress`); only a workflow-layer sweep frees the gate.
 */
export async function reapOrphanedGatesSweep(
  rt: ThreadGateReaperRuntime,
  nowMs: number,
  graceMs: number = ORPHAN_GATE_GRACE_MS,
): Promise<number> {
  const cutoffMs = nowMs - graceMs;
  const workflowIds = await rt.listOrphanedGateWorkflows(cutoffMs);
  let reaped = 0;
  for (const workflowId of workflowIds) {
    await rt.cancelGateWorkflow(workflowId);
    reaped++;
    orphanedGateReapedCounter.add(1);
    console.warn(
      JSON.stringify({
        msg: "thread-gate-reaper",
        event: "orphaned-gate-reaped",
        workflowId,
        cutoffMs,
      }),
    );
  }
  return reaped;
}

async function reaperWorkflowFn(
  _scheduledTime: Date,
  currentTime: Date,
): Promise<void> {
  const rt = runtime;
  if (!rt) return;
  await DBOS.runStep(
    async () => {
      try {
        const n = await reapStuckRunsSweep(rt, currentTime.getTime());
        if (n > 0) {
          console.log(`[thread-gate-reaper] force-failed ${n} stuck run(s)`);
        }
      } catch (err) {
        // A sweep failure must never kill the schedule.
        console.error("[thread-gate-reaper] sweep failed", err);
      }
      try {
        const n = await reapOrphanedGatesSweep(rt, currentTime.getTime());
        if (n > 0) {
          console.log(`[thread-gate-reaper] cancelled ${n} orphaned gate(s)`);
        }
      } catch (err) {
        // A sweep failure must never kill the schedule.
        console.error("[thread-gate-reaper] orphaned-gate sweep failed", err);
      }
    },
    { name: "threadGateReaperSweep" },
  );
}

let registered = false;

/** Idempotent; must run before DBOS.launch(). Guarded against HMR re-register. */
export function registerThreadGateReaperWorkflow(): void {
  if (registered) return;
  registered = true;
  // ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
  // step, or change a step's recorded I/O) requires bumping DBOS_WORKFLOW_VERSION
  // — see apps/mesh/src/dbos/workflow-version.ts.
  const wf = DBOS.registerWorkflow(reaperWorkflowFn, {
    name: "threadGateReaperWorkflow",
  });
  DBOS.registerScheduled(wf, {
    name: "threadGateReaperWorkflow",
    crontab: REAPER_CRONTAB,
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
}
