/**
 * DBOS scheduled workflow for the per-org repo syncs (org-repo-sync.ts).
 *
 * Same coordination story as dbos-public-sets-sync.ts: the scheduler picks one
 * pod per tick, per-config steps journal progress so a pod death mid-sweep
 * resumes at the failed config. Unlike the public sets (env-derived, identical
 * on every pod), the work list here comes from the DB — so it is read inside a
 * STEP: the recorded step output is what a replay sees, which keeps the
 * step sequence deterministic even if the table changes mid-tick.
 *
 * Runtime deps are looked up via a module-level registry wired by app boot via
 * `setOrgRepoSyncRuntime` BEFORE `DBOS.launch()`.
 */

import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";
import type { Kysely } from "kysely";
import { ContextFactory, rebindOrgScope } from "@/core/context-factory";
import type { StudioContext } from "@/core/studio-context";
import type { Database, OrgRepoSync } from "../storage/types";
import { OrgRepoSyncStorage } from "../storage/org-repo-syncs";
import { syncOrgRepoSafe } from "./org-repo-sync";

/** Every 10 minutes, offset from the public-sets tick (:04) so one pod never
 *  runs both sweeps at once. */
const ORG_REPO_SYNC_CRONTAB = "7-59/10 * * * *";

export interface OrgRepoSyncRuntime {
  db: Kysely<Database>;
}

let runtime: OrgRepoSyncRuntime | null = null;

/** Wire deps for the workflow body. Safe to call before `DBOS.launch()`:
 *  it only writes a module-level pointer, no DBOS API calls. */
export function setOrgRepoSyncRuntime(rt: OrgRepoSyncRuntime): void {
  runtime = rt;
}

function requireRuntime(): OrgRepoSyncRuntime {
  if (!runtime) {
    throw new Error(
      "[org-fs] org-repo-sync runtime not initialized — setOrgRepoSyncRuntime() must run before the workflow fires",
    );
  }
  return runtime;
}

/**
 * User-less StudioContext bound to the config's org — the sync needs
 * `ctx.organization` for the token mint (which is superUser-safe in
 * background contexts) and the org-rebound storage facets for the volume
 * writes. Returns null when the org row is gone (cascade already queued).
 */
async function buildOrgContext(
  db: Kysely<Database>,
  orgId: string,
): Promise<StudioContext | null> {
  const org = await db
    .selectFrom("organization")
    .select(["id", "slug", "name"])
    .where("id", "=", orgId)
    .executeTakeFirst();
  if (!org) return null;
  const ctx = await ContextFactory.create();
  ctx.organization = { id: org.id, slug: org.slug, name: org.name };
  rebindOrgScope(ctx, { id: org.id, slug: org.slug });
  return ctx;
}

/** One config, folded to a result — the step body must never throw. */
async function runOneConfig(
  config: OrgRepoSync,
): Promise<{ id: string; volume: string; error?: string }> {
  try {
    const { db } = requireRuntime();
    const ctx = await buildOrgContext(db, config.organizationId);
    if (!ctx) {
      return {
        id: config.id,
        volume: config.volume,
        error: "organization no longer exists",
      };
    }
    const result = await syncOrgRepoSafe(ctx, config);
    return "error" in result
      ? { id: result.id, volume: result.volume, error: result.error }
      : { id: result.id, volume: result.volume };
  } catch (err) {
    // Fold context-build failures too — one bad config must not fail the
    // workflow tick and skip every remaining org's sync.
    return {
      id: config.id,
      volume: config.volume,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function orgRepoSyncWorkflowFn(
  _scheduledTime: Date,
  _currentTime: Date,
): Promise<void> {
  // DB-derived work list: read inside a step so the recorded output — not a
  // fresh query — is what a replayed workflow iterates over.
  const configs = await DBOS.runStep(
    () => new OrgRepoSyncStorage(requireRuntime().db).listEnabled(),
    { name: "loadOrgRepoSyncConfigs" },
  );
  for (const config of configs) {
    const result = await DBOS.runStep(() => runOneConfig(config), {
      name: `syncOrgRepo:${config.id}`,
    });
    if (result.error) {
      console.warn(
        `[org-fs] org repo sync ${result.id} (${result.volume}) failed: ${result.error}`,
      );
    }
  }
}

let registeredWorkflow: typeof orgRepoSyncWorkflowFn | null = null;

// Must run before DBOS.launch(). Guarded so HMR repeats don't re-register.
export function registerOrgRepoSyncWorkflow(): void {
  if (registeredWorkflow) return;
  // ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
  // step, or change a step's recorded I/O) requires bumping DBOS_WORKFLOW_VERSION
  // — see apps/api/src/dbos/workflow-version.ts.
  registeredWorkflow = DBOS.registerWorkflow(orgRepoSyncWorkflowFn, {
    name: "orgRepoSyncWorkflow",
  });
  DBOS.registerScheduled(registeredWorkflow, {
    name: "orgRepoSyncWorkflow",
    crontab: ORG_REPO_SYNC_CRONTAB,
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
}
