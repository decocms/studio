/**
 * DBOS scheduled workflow that returns every demo org's board to its capture
 * each morning, before anyone demos (see `reset.ts`).
 *
 * Same shape as `dbos-archive-sweep.ts`: one pod per tick, the work list read
 * inside a step so a replay iterates the recorded list, and each org's leg its
 * own step that never throws.
 *
 * Runtime deps come from a module-level registry wired by app boot via
 * `setDemoBoardResetRuntime` BEFORE `DBOS.launch()`.
 */

import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";
import type { Kysely } from "kysely";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import { DemoBoardStorage } from "@/storage/demo-board";
import type { Database } from "@/storage/types";
import { buildOrgContext } from "../task-board/org-context";
import { resetDemoBoard } from "./reset";

/** 09:00 UTC is 06:00 in São Paulo, ahead of the working day. */
const DEMO_BOARD_RESET_CRONTAB = "0 9 * * *";

export interface DemoBoardResetRuntime {
  db: Kysely<Database>;
}

let runtime: DemoBoardResetRuntime | null = null;

/** Wire deps for the workflow body. Safe to call before `DBOS.launch()`. */
export function setDemoBoardResetRuntime(rt: DemoBoardResetRuntime): void {
  runtime = rt;
}

function requireRuntime(): DemoBoardResetRuntime {
  if (!runtime) {
    throw new Error(
      "[demo-board] runtime not initialized — setDemoBoardResetRuntime() must run before the workflow fires",
    );
  }
  return runtime;
}

/** Orgs with a capture AND the flag on: switching it off pauses the reset. */
async function listDemoOrgs(): Promise<string[]> {
  const { db } = requireRuntime();
  const orgIds = await new DemoBoardStorage(db).listOrganizationIds();
  if (orgIds.length === 0) return [];
  const settings = await db
    .selectFrom("organization_settings")
    .select(["organizationId", "flags"])
    .where("organizationId", "in", orgIds)
    .execute();
  return settings
    .filter((row) => orgFlagEnabled(row.flags, "demo_board_reset"))
    .map((row) => row.organizationId);
}

/** One org, folded to a result — the step body must never throw. */
async function resetOneOrg(
  organizationId: string,
): Promise<{ organizationId: string; error?: string }> {
  try {
    const ctx = await buildOrgContext(requireRuntime().db, organizationId);
    if (ctx) await resetDemoBoard(ctx, organizationId);
    return { organizationId };
  } catch (err) {
    return {
      organizationId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function demoBoardResetWorkflowFn(
  _scheduledTime: Date,
  _currentTime: Date,
): Promise<void> {
  const orgIds = await DBOS.runStep(() => listDemoOrgs(), {
    name: "listDemoOrgs",
  });
  const results = await Promise.all(
    orgIds.map((organizationId) =>
      DBOS.runStep(() => resetOneOrg(organizationId), {
        name: `resetDemoBoard:${organizationId}`,
      }),
    ),
  );
  for (const result of results) {
    if (result.error) {
      console.error(
        `[demo-board] reset of ${result.organizationId} failed: ${result.error}`,
      );
    }
  }
}

let registeredWorkflow: typeof demoBoardResetWorkflowFn | null = null;

/**
 * Must run before DBOS.launch(). Guarded so HMR repeats don't re-register.
 *
 * ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
 * step, or change a step's recorded I/O) requires bumping
 * DBOS_WORKFLOW_VERSION — see apps/api/src/dbos/workflow-version.ts.
 */
export function registerDemoBoardResetWorkflow(): void {
  if (registeredWorkflow) return;
  registeredWorkflow = DBOS.registerWorkflow(demoBoardResetWorkflowFn, {
    name: "demoBoardResetWorkflow",
  });
  DBOS.registerScheduled(registeredWorkflow, {
    name: "demoBoardResetWorkflow",
    crontab: DEMO_BOARD_RESET_CRONTAB,
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
}
