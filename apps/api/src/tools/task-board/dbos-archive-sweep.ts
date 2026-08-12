/**
 * DBOS scheduled workflow that auto-archives settled Done cards (see
 * `archive-merged.ts` for the rule).
 *
 * Same shape as `dbos-org-repo-sync.ts`: the scheduler picks ONE pod per tick
 * (so three replicas don't triple the GitHub reads), the work list is read
 * inside a step so a replay iterates the recorded list rather than a fresh
 * query, and each org's leg is its own step that never throws — one org's dead
 * GitHub connection can't skip every other org's sweep.
 *
 * The org legs run concurrently: `Promise.all` over the grouped work list issues
 * the `runStep` calls synchronously in list order, so the recorded step sequence
 * is deterministic even though the steps overlap.
 *
 * Runtime deps come from a module-level registry wired by app boot via
 * `setTaskBoardArchiveSweepRuntime` BEFORE `DBOS.launch()`.
 */

import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";
import type { Kysely } from "kysely";
import { TaskBoardStorage } from "@/storage/task-board";
import type { Database } from "@/storage/types";
import { archiveMergedForOrg, groupByOrg } from "./archive-merged";
import { buildOrgContext } from "./org-context";

/** Hourly, at :23 — off the other sweeps' ticks so one pod never runs two. */
const ARCHIVE_SWEEP_CRONTAB = "23 * * * *";

/** A Done card is only archivable once it has sat untouched this long. */
const SETTLED_FOR_MS = 24 * 60 * 60 * 1000;

/** Ceiling on candidates per tick, across all orgs — each costs one GitHub read
 *  per linked PR. A backlog drains over the following hours. */
const MAX_CANDIDATES_PER_TICK = 200;

export interface TaskBoardArchiveSweepRuntime {
  db: Kysely<Database>;
}

let runtime: TaskBoardArchiveSweepRuntime | null = null;

/** Wire deps for the workflow body. Safe to call before `DBOS.launch()`:
 *  it only writes a module-level pointer, no DBOS API calls. */
export function setTaskBoardArchiveSweepRuntime(
  rt: TaskBoardArchiveSweepRuntime,
): void {
  runtime = rt;
}

function requireRuntime(): TaskBoardArchiveSweepRuntime {
  if (!runtime) {
    throw new Error(
      "[task-board-archive] runtime not initialized — setTaskBoardArchiveSweepRuntime() must run before the workflow fires",
    );
  }
  return runtime;
}

/** One org, folded to a result — the step body must never throw. */
async function sweepOneOrg(
  organizationId: string,
  itemIds: string[],
): Promise<{ organizationId: string; archived: number; error?: string }> {
  try {
    const ctx = await buildOrgContext(requireRuntime().db, organizationId);
    if (!ctx) return { organizationId, archived: 0 };
    const { archived } = await archiveMergedForOrg(
      ctx,
      organizationId,
      itemIds,
    );
    return { organizationId, archived };
  } catch (err) {
    return {
      organizationId,
      archived: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function archiveSweepWorkflowFn(
  scheduledTime: Date,
  _currentTime: Date,
): Promise<void> {
  // Cutoff off the SCHEDULED time, so a replayed tick asks for the same window.
  const settledBefore = new Date(scheduledTime.getTime() - SETTLED_FOR_MS);
  const candidates = await DBOS.runStep(
    () =>
      new TaskBoardStorage(requireRuntime().db).listItemsAwaitingArchive(
        settledBefore,
        MAX_CANDIDATES_PER_TICK,
      ),
    { name: "loadArchiveCandidates" },
  );
  if (candidates.length === 0) return;

  const results = await Promise.all(
    groupByOrg(candidates).map(({ organizationId, itemIds }) =>
      DBOS.runStep(() => sweepOneOrg(organizationId, itemIds), {
        name: `archiveMergedForOrg:${organizationId}`,
      }),
    ),
  );
  for (const result of results) {
    if (result.error) {
      console.warn(
        `[task-board-archive] org ${result.organizationId} failed: ${result.error}`,
      );
    }
  }
  const archived = results.reduce((sum, r) => sum + r.archived, 0);
  if (archived > 0) {
    console.log(
      `[task-board-archive] archived ${archived} of ${candidates.length} candidates`,
    );
  }
}

let registeredWorkflow: typeof archiveSweepWorkflowFn | null = null;

/**
 * Must run before DBOS.launch(). Guarded so HMR repeats don't re-register.
 *
 * ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
 * step, or change a step's recorded I/O) requires bumping
 * DBOS_WORKFLOW_VERSION — see apps/api/src/dbos/workflow-version.ts.
 */
export function registerTaskBoardArchiveSweepWorkflow(): void {
  if (registeredWorkflow) return;
  registeredWorkflow = DBOS.registerWorkflow(archiveSweepWorkflowFn, {
    name: "taskBoardArchiveSweepWorkflow",
  });
  DBOS.registerScheduled(registeredWorkflow, {
    name: "taskBoardArchiveSweepWorkflow",
    crontab: ARCHIVE_SWEEP_CRONTAB,
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
}
