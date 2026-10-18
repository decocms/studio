/**
 * DBOS scheduled workflow that keeps repository briefs current (see
 * `refresh.ts`). Same shape as `tools/task-board/dbos-archive-sweep.ts`: one
 * pod per tick, the work list read inside a step, one never-throwing step per
 * org.
 *
 * Budget: at most `MAX_REPOSITORIES_PER_TICK` repositories per hourly tick,
 * each at most five provider reads and one fast-tier call. Orgs run one after
 * another, so a tick never bursts more than one repository's reads at a time.
 */

import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";
import type { Kysely } from "kysely";
import { buildOrgContext } from "@/tools/task-board/org-context";
import { RepositoryBriefStorage } from "@/storage/repository-briefs";
import type { Database } from "@/storage/types";
import { refreshBriefsForOrg } from "./refresh";

/** Hourly, at :53 — off the other sweeps' ticks so one pod never runs two. */
const BRIEF_SWEEP_CRONTAB = "53 * * * *";

const MAX_REPOSITORIES_PER_TICK = 20;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** A failed build waits this long before the next attempt. */
const RETRY_AFTER_MS = 60 * 60 * 1000;

export interface RepoBriefSweepRuntime {
  db: Kysely<Database>;
}

let runtime: RepoBriefSweepRuntime | null = null;

/** Wire deps for the workflow body. Safe to call before `DBOS.launch()`. */
export function setRepoBriefSweepRuntime(rt: RepoBriefSweepRuntime): void {
  runtime = rt;
}

function requireRuntime(): RepoBriefSweepRuntime {
  if (!runtime) {
    throw new Error(
      "[repo-upkeep] runtime not initialized — setRepoBriefSweepRuntime() must run before the workflow fires",
    );
  }
  return runtime;
}

async function refreshOneOrg(
  organizationId: string,
  repositoryIds: string[],
  now: Date,
): Promise<{ organizationId: string; failed: number; error?: string }> {
  try {
    const { db } = requireRuntime();
    const ctx = await buildOrgContext(db, organizationId);
    if (!ctx) return { organizationId, failed: 0 };
    const { failed } = await refreshBriefsForOrg(
      ctx,
      new RepositoryBriefStorage(db),
      organizationId,
      repositoryIds,
      now,
    );
    return { organizationId, failed };
  } catch (err) {
    return {
      organizationId,
      failed: repositoryIds.length,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function briefSweepWorkflowFn(
  scheduledTime: Date,
  _currentTime: Date,
): Promise<void> {
  // Cutoffs off the SCHEDULED time, so a replayed tick asks for the same list.
  const now = scheduledTime;
  const due = await DBOS.runStep(
    () =>
      new RepositoryBriefStorage(requireRuntime().db).listDue(
        new Date(now.getTime() - STALE_AFTER_MS),
        new Date(now.getTime() - RETRY_AFTER_MS),
        MAX_REPOSITORIES_PER_TICK,
      ),
    { name: "loadDueRepositoryBriefs" },
  );
  const byOrg = new Map<string, string[]>();
  for (const { organizationId, repositoryId } of due) {
    byOrg.set(organizationId, [
      ...(byOrg.get(organizationId) ?? []),
      repositoryId,
    ]);
  }
  for (const [organizationId, repositoryIds] of byOrg) {
    const result = await DBOS.runStep(
      () => refreshOneOrg(organizationId, repositoryIds, now),
      { name: `refreshRepositoryBriefs:${organizationId}` },
    );
    if (result.error || result.failed > 0) {
      console.warn(
        `[repo-upkeep] org ${organizationId}: ${result.failed} of ${repositoryIds.length} briefs failed${result.error ? ` (${result.error})` : ""}`,
      );
    }
  }
}

let registeredWorkflow: typeof briefSweepWorkflowFn | null = null;

/**
 * Must run before DBOS.launch(). Guarded so HMR repeats don't re-register.
 *
 * ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE requires bumping
 * DBOS_WORKFLOW_VERSION — see apps/api/src/dbos/workflow-version.ts.
 */
export function registerRepoBriefSweepWorkflow(): void {
  if (registeredWorkflow) return;
  registeredWorkflow = DBOS.registerWorkflow(briefSweepWorkflowFn, {
    name: "repoBriefSweepWorkflow",
  });
  DBOS.registerScheduled(registeredWorkflow, {
    name: "repoBriefSweepWorkflow",
    crontab: BRIEF_SWEEP_CRONTAB,
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
}
