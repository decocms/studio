/**
 * One-off: the order ingest for every VTEX connection that had its keys
 * before saving them installed it (`order-ingest-install.ts`). Runs once per
 * deployment history, keyed on a fixed workflow id, so a store whose ingest
 * was removed on purpose later isn't reinstalled on the next boot; a VTEX
 * connection saved again gets it from the save itself. Bump the id to run it
 * again.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import type { Kysely } from "kysely";
import type { StudioContextFactory } from "@/automations/fire";
import { requireOrganization } from "@/core/studio-context";
import type { Database } from "@/storage/types";
import { provisionOrderIngest } from "./order-ingest-install";

const BACKFILL_WORKFLOW_ID = "order-ingest-backfill:1";

interface VtexConnection {
  id: string;
  organizationId: string;
  createdBy: string;
}

let runtime: {
  db: Kysely<Database>;
  contextFactory: StudioContextFactory;
} | null = null;

/** Wire deps for the workflow body. Safe to call before `DBOS.launch()`. */
export function setOrderIngestBackfillRuntime(rt: {
  db: Kysely<Database>;
  contextFactory: StudioContextFactory;
}): void {
  runtime = rt;
}

function requireRuntime() {
  if (!runtime) {
    throw new Error(
      "[order-ingest] runtime not initialized — setOrderIngestBackfillRuntime() must run before the workflow fires",
    );
  }
  return runtime;
}

async function listVtexConnections(): Promise<VtexConnection[]> {
  const rows = await requireRuntime()
    .db.selectFrom("connections")
    .select(["id", "organization_id", "created_by"])
    .where("status", "=", "active")
    .where((eb) =>
      eb.or([eb("app_id", "=", "deco/vtex"), eb("app_name", "=", "vtex")]),
    )
    .orderBy("id")
    .execute();
  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organization_id,
    createdBy: r.created_by,
  }));
}

/** As the connection's creator; `provisionOrderIngest` skips those without keys or the plan, and never throws. */
async function backfillOne(c: VtexConnection): Promise<void> {
  try {
    const ctx = await requireRuntime().contextFactory(
      c.organizationId,
      c.createdBy,
    );
    if (!ctx) return;
    const connection = await ctx.storage.connections.findById(
      c.id,
      c.organizationId,
    );
    if (!connection) return;
    await provisionOrderIngest(ctx, {
      organization: requireOrganization(ctx),
      userId: c.createdBy,
      connection,
    });
  } catch (error) {
    console.error(
      "[order-ingest] backfill failed",
      { connectionId: c.id },
      error,
    );
  }
}

async function orderIngestBackfillWorkflowFn(): Promise<void> {
  const connections = await DBOS.runStep(listVtexConnections, {
    name: "listVtexConnections",
  });
  for (const c of connections) {
    await DBOS.runStep(() => backfillOne(c), {
      name: `backfillOrderIngest:${c.id}`,
    });
  }
}

let registeredWorkflow: typeof orderIngestBackfillWorkflowFn | null = null;

/**
 * Must run before DBOS.launch(). Guarded so HMR repeats don't re-register.
 *
 * ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
 * step, or change a step's recorded I/O) requires bumping
 * DBOS_WORKFLOW_VERSION — see apps/api/src/dbos/workflow-version.ts.
 */
export function registerOrderIngestBackfillWorkflow(): void {
  if (registeredWorkflow) return;
  registeredWorkflow = DBOS.registerWorkflow(orderIngestBackfillWorkflowFn, {
    name: "orderIngestBackfillWorkflow",
  });
}

/** Must run AFTER `DBOS.launch()`. Replicas booting together share the id, so it runs once. */
export async function kickOrderIngestBackfill(): Promise<void> {
  if (!registeredWorkflow) return;
  await DBOS.startWorkflow(registeredWorkflow, {
    workflowID: BACKFILL_WORKFLOW_ID,
  })();
}
