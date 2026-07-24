/**
 * DBOS scheduled workflow for the public skill-set sync.
 *
 * Replaces the per-pod boot loop: N replicas each ran their own 10-minute
 * interval, so every tick fetched N tarballs and raced the same
 * delete-before-write sequence against the shared volumes. The DBOS scheduler
 * coordinates through the system DB (deterministic workflow ID per tick), so
 * exactly one pod owns a tick; per-set steps journal progress, so a pod death
 * mid-sweep resumes from the failed set instead of refetching everything.
 *
 * Runtime deps (db, baseUrl) are looked up via a module-level registry wired
 * by app boot via `setPublicSetsSyncRuntime` BEFORE `DBOS.launch()` — same
 * pattern as automations/dbos-workflow.ts.
 */

import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";
import type { Kysely } from "kysely";
import type { Database } from "../storage/types";
import { getPublicSets } from "./public-sets";
import { syncPublicSetSafe } from "./skill-set-sync";

/** Every 10 minutes, off the :00 boundary to avoid colliding with hourly tasks. */
const PUBLIC_SETS_SYNC_CRONTAB = "4-59/10 * * * *";

export interface PublicSetsSyncRuntime {
  db: Kysely<Database>;
  baseUrl: string;
}

let runtime: PublicSetsSyncRuntime | null = null;

/** Wire deps for the workflow body. Safe to call before `DBOS.launch()`:
 *  it only writes a module-level pointer, no DBOS API calls. */
export function setPublicSetsSyncRuntime(rt: PublicSetsSyncRuntime): void {
  runtime = rt;
}

function requireRuntime(): PublicSetsSyncRuntime {
  if (!runtime) {
    throw new Error(
      "[org-fs] public-sets sync runtime not initialized — setPublicSetsSyncRuntime() must run before the workflow fires",
    );
  }
  return runtime;
}

async function publicSetsSyncWorkflowFn(
  _scheduledTime: Date,
  _currentTime: Date,
): Promise<void> {
  // Env-derived config, identical on every pod — deterministic across replays.
  for (const source of getPublicSets()) {
    const result = await DBOS.runStep(
      () => {
        const rt = requireRuntime();
        return syncPublicSetSafe(rt.db, source, { baseUrl: rt.baseUrl });
      },
      { name: `syncPublicSet:${source.set}` },
    );
    if ("error" in result) {
      console.warn(
        `[org-fs] public set "${result.set}" sync failed: ${result.error}`,
      );
    } else if (result.written || result.deleted) {
      console.log(
        `[org-fs] public set "${result.set}" synced: +${result.written} -${result.deleted} (=${result.unchanged})`,
      );
    }
  }
}

let registeredWorkflow: typeof publicSetsSyncWorkflowFn | null = null;

// Must run before DBOS.launch(). Guarded so HMR repeats don't re-register.
export function registerPublicSetsSyncWorkflow(): void {
  if (registeredWorkflow) return;
  // ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
  // step, or change a step's recorded I/O) requires bumping DBOS_WORKFLOW_VERSION
  // — see apps/api/src/dbos/workflow-version.ts.
  registeredWorkflow = DBOS.registerWorkflow(publicSetsSyncWorkflowFn, {
    name: "publicSetsSyncWorkflow",
  });
  DBOS.registerScheduled(registeredWorkflow, {
    name: "publicSetsSyncWorkflow",
    crontab: PUBLIC_SETS_SYNC_CRONTAB,
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
}

/**
 * Boot kick: one immediate sync per boot wave so a fresh deployment doesn't
 * serve empty volumes until the first cron tick. The hour-bucketed workflow
 * ID collapses N replicas booting together via OAOO; a redeploy later in the
 * same hour skips it, which is fine — the schedule covers it within 10
 * minutes. Must run AFTER `DBOS.launch()`.
 */
export async function kickPublicSetsBootSync(): Promise<void> {
  if (getPublicSets().length === 0 || !registeredWorkflow) return;
  const now = new Date();
  const workflowID = `public-sets-sync-boot:${now.toISOString().slice(0, 13)}`;
  await DBOS.startWorkflow(registeredWorkflow, { workflowID })(now, now);
}
