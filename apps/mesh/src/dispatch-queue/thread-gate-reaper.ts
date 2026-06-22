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

/** Every minute (crontab granularity floor). */
const REAPER_CRONTAB = "* * * * *";

export interface ThreadGateReaperRuntime {
  listStuckRuns(
    cutoffIso: string,
  ): Promise<Array<{ id: string; organizationId: string }>>;
  forceFailIfInProgress(id: string, organizationId: string): Promise<boolean>;
}

let runtime: ThreadGateReaperRuntime | null = null;

export function setThreadGateReaperRuntime(rt: ThreadGateReaperRuntime): void {
  runtime = rt;
}

const reapedCounter = meter.createCounter("decopilot.gate.reaped", {
  description: "Runs force-failed by the cross-pod thread-gate reaper",
  unit: "{runs}",
});

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
    },
    { name: "threadGateReaperSweep" },
  );
}

let registered = false;

/** Idempotent; must run before DBOS.launch(). Guarded against HMR re-register. */
export function registerThreadGateReaperWorkflow(): void {
  if (registered) return;
  registered = true;
  const wf = DBOS.registerWorkflow(reaperWorkflowFn, {
    name: "threadGateReaperWorkflow",
  });
  DBOS.registerScheduled(wf, {
    name: "threadGateReaperWorkflow",
    crontab: REAPER_CRONTAB,
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
}
