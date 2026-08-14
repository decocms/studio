/**
 * DBOS scheduled workflow that tags Done cards whose PRs landed (see
 * `tag-merged.ts` for the rule).
 *
 * Same shape as `dbos-archive-sweep.ts`: the scheduler picks ONE pod per tick
 * (so three replicas don't triple the GitHub reads), the work list is read
 * inside a step so a replay iterates the recorded list rather than a fresh
 * query, and each org's leg is its own step that never throws — one org's dead
 * GitHub connection can't skip every other org's sweep.
 *
 * Its own workflow rather than a second leg of the archive sweep: that one only
 * looks at cards settled for five days, and a `merged` tag five days late is a
 * tag nobody saw when it mattered.
 *
 * Runtime deps come from a module-level registry wired by app boot via
 * `setTaskBoardMergedTagSweepRuntime` BEFORE `DBOS.launch()`.
 */

import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";
import type { Kysely } from "kysely";
import { TaskBoardStorage } from "@/storage/task-board";
import type { Database } from "@/storage/types";
import { groupByOrg } from "./archive-merged";
import { buildOrgContext } from "./org-context";
import { MERGED_TAG_NAME, tagMergedForOrg } from "./tag-merged";

/** Hourly, at :41 — off the other sweeps' ticks so one pod never runs two. */
const MERGED_TAG_SWEEP_CRONTAB = "41 * * * *";

/** Ceiling on candidates per tick, across all orgs — each costs one GitHub read
 *  per linked PR. A backlog (including every card that predates this sweep)
 *  drains over the following hours. */
const MAX_CANDIDATES_PER_TICK = 200;

export interface TaskBoardMergedTagSweepRuntime {
  db: Kysely<Database>;
}

let runtime: TaskBoardMergedTagSweepRuntime | null = null;

/** Wire deps for the workflow body. Safe to call before `DBOS.launch()`:
 *  it only writes a module-level pointer, no DBOS API calls. */
export function setTaskBoardMergedTagSweepRuntime(
  rt: TaskBoardMergedTagSweepRuntime,
): void {
  runtime = rt;
}

function requireRuntime(): TaskBoardMergedTagSweepRuntime {
  if (!runtime) {
    throw new Error(
      "[task-board-merged-tag] runtime not initialized — setTaskBoardMergedTagSweepRuntime() must run before the workflow fires",
    );
  }
  return runtime;
}

/** One org, folded to a result — the step body must never throw. */
async function sweepOneOrg(
  organizationId: string,
  itemIds: string[],
): Promise<{ organizationId: string; tagged: number; error?: string }> {
  try {
    const ctx = await buildOrgContext(requireRuntime().db, organizationId);
    if (!ctx) return { organizationId, tagged: 0 };
    const { tagged } = await tagMergedForOrg(ctx, organizationId, itemIds);
    return { organizationId, tagged };
  } catch (err) {
    return {
      organizationId,
      tagged: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function mergedTagSweepWorkflowFn(): Promise<void> {
  const candidates = await DBOS.runStep(
    () =>
      new TaskBoardStorage(requireRuntime().db).listItemsAwaitingMergedTag(
        MERGED_TAG_NAME,
        MAX_CANDIDATES_PER_TICK,
      ),
    { name: "loadMergedTagCandidates" },
  );
  if (candidates.length === 0) return;

  const results = await Promise.all(
    groupByOrg(candidates).map(({ organizationId, itemIds }) =>
      DBOS.runStep(() => sweepOneOrg(organizationId, itemIds), {
        name: `tagMergedForOrg:${organizationId}`,
      }),
    ),
  );
  for (const result of results) {
    if (result.error) {
      console.warn(
        `[task-board-merged-tag] org ${result.organizationId} failed: ${result.error}`,
      );
    }
  }
  const tagged = results.reduce((sum, r) => sum + r.tagged, 0);
  if (tagged > 0) {
    console.log(
      `[task-board-merged-tag] tagged ${tagged} of ${candidates.length} candidates`,
    );
  }
}

let registeredWorkflow: typeof mergedTagSweepWorkflowFn | null = null;

/**
 * Must run before DBOS.launch(). Guarded so HMR repeats don't re-register.
 *
 * ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
 * step, or change a step's recorded I/O) requires bumping
 * DBOS_WORKFLOW_VERSION — see apps/api/src/dbos/workflow-version.ts.
 */
export function registerTaskBoardMergedTagSweepWorkflow(): void {
  if (registeredWorkflow) return;
  registeredWorkflow = DBOS.registerWorkflow(mergedTagSweepWorkflowFn, {
    name: "taskBoardMergedTagSweepWorkflow",
  });
  DBOS.registerScheduled(registeredWorkflow, {
    name: "taskBoardMergedTagSweepWorkflow",
    crontab: MERGED_TAG_SWEEP_CRONTAB,
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
}
