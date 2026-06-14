import "./capabilities"; // load defineCapability side effects before registration
import { orgActivity } from "@/core/activity";
import type { Database } from "@/storage/types";
import {
  initTelos,
  type TelosStore,
  type TelosTables,
} from "@decocms/telos/postgres";
import type { Kysely } from "kysely";
import { pullPursuit, registerPursuitWorkflows } from "./durable/pursuit";
import { registerTelosCapabilities } from "./durable/registry";
import { setTelosRuntime } from "./durable/runtime";
import type { Goal } from "./target";

export { initTelosDbos } from "./durable/queue";

// telos owns its storage (the `telos` schema); the cast is the one boundary
// where mesh's Kysely<Database> meets telos's own tables over the same Postgres.
const asTelos = (db: Kysely<Database>) => db as unknown as Kysely<TelosTables>;

let store: TelosStore<Goal> | null = null;

// One call at app boot, before DBOS.launch(): migrate the telos schema, build
// the stores, stash deps for capability steps, and register durable capabilities.
export async function bootTelos(db: Kysely<Database>): Promise<void> {
  store = await initTelos<Goal>({ db: asTelos(db) });
  setTelosRuntime({ db, store });
  registerTelosCapabilities();
  registerPursuitWorkflows();

  // Reactivity: any org activity (a mutating tool call, a fired automation) pulls
  // that org's next pursuit cycle forward. Decoupled — producers know nothing of
  // telos. Best-effort; the debouncer coalesces and the tick guards goal-less orgs.
  orgActivity.subscribe((activity) => {
    void pullPursuit(activity.organizationId);
  });
}

export function telos(): TelosStore<Goal> {
  if (!store) {
    throw new Error(
      "[telos] not initialized — bootTelos() must run at app boot",
    );
  }
  return store;
}
