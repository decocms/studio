/**
 * DBOS scheduled workflow that forwards the channels hub into Studio (see
 * `hub-forwarder.ts`). Same shape as `dbos-archive-sweep.ts`: the scheduler
 * picks one pod per tick, the connection list is read inside a step so a
 * replay iterates the recorded list, and each connection's leg is its own
 * step that never throws, so one broken connection doesn't stop the others.
 *
 * A no-op without CHANNELS_SOURCE_DATABASE_URL, and it only copies into the
 * orgs deco listed in CHANNELS_SOURCE_ORG_IDS that have `channels_enabled` on. Runtime deps come from a
 * module-level registry wired by app boot via `setChannelsHubForwarderRuntime`
 * BEFORE `DBOS.launch()`.
 */

import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";
import type { Kysely } from "kysely";
import { Pool } from "pg";
import { ChannelsStorage } from "@/storage/channels";
import type { Database } from "@/storage/types";
import { forwardConnection } from "./hub-forwarder";

const HUB_FORWARDER_CRONTAB = "* * * * *";

export interface ChannelsHubForwarderRuntime {
  db: Kysely<Database>;
  sourceDatabaseUrl: string | undefined;
  /** The only orgs it copies into (CHANNELS_SOURCE_ORG_IDS). */
  sourceOrgIds: string[];
}

let runtime: ChannelsHubForwarderRuntime | null = null;
let sourcePool: Pool | null = null;

/** Wire deps for the workflow body. Safe to call before `DBOS.launch()`:
 *  it only writes a module-level pointer, no DBOS API calls. */
export function setChannelsHubForwarderRuntime(
  rt: ChannelsHubForwarderRuntime,
): void {
  runtime = rt;
}

function requireRuntime(): ChannelsHubForwarderRuntime {
  if (!runtime) {
    throw new Error(
      "[channels-forwarder] runtime not initialized — setChannelsHubForwarderRuntime() must run before the workflow fires",
    );
  }
  return runtime;
}

/** The hub's own small read-only pool, apart from Studio's database. */
function hubPool(connectionString: string): Pool {
  if (!sourcePool) {
    sourcePool = new Pool({
      connectionString,
      max: 2,
      statement_timeout: 30_000,
      options: "-c default_transaction_read_only=on",
    });
    sourcePool.on("error", (err) =>
      console.warn(`[channels-forwarder] hub pool error: ${err.message}`),
    );
  }
  return sourcePool;
}

async function hubForwarderWorkflowFn(
  _scheduledTime: Date,
  _currentTime: Date,
): Promise<void> {
  // Env-derived, identical on every pod — deterministic across replays.
  const { db, sourceDatabaseUrl, sourceOrgIds } = requireRuntime();
  if (!sourceDatabaseUrl || sourceOrgIds.length === 0) return;

  const connections = await DBOS.runStep(
    () => new ChannelsStorage(db).listSourceSyncs(sourceOrgIds),
    { name: "listChannelConnections" },
  );
  // ponytail: every connection every tick, one after another (each capped at
  // HUB_BATCH rows); shard or cap connections per tick if they number hundreds.
  for (const connection of connections) {
    const result = await DBOS.runStep(
      () =>
        forwardConnection(
          new ChannelsStorage(db),
          hubPool(sourceDatabaseUrl),
          connection,
        ),
      { name: `forwardChannelConnection:${connection.id}` },
    );
    if (result.error) {
      console.warn(
        `[channels-forwarder] connection ${connection.id} failed: ${result.error}`,
      );
    }
  }
}

let registeredWorkflow: typeof hubForwarderWorkflowFn | null = null;

/**
 * Must run before DBOS.launch(). Guarded so HMR repeats don't re-register.
 *
 * ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
 * step, or change a step's recorded I/O) requires bumping
 * DBOS_WORKFLOW_VERSION — see apps/api/src/dbos/workflow-version.ts.
 */
export function registerChannelsHubForwarderWorkflow(): void {
  if (registeredWorkflow) return;
  registeredWorkflow = DBOS.registerWorkflow(hubForwarderWorkflowFn, {
    name: "channelsHubForwarderWorkflow",
  });
  DBOS.registerScheduled(registeredWorkflow, {
    name: "channelsHubForwarderWorkflow",
    crontab: HUB_FORWARDER_CRONTAB,
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
}
