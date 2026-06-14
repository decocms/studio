import "./capabilities"; // load defineCapability side effects before registration
import type { Database } from "@/storage/types";
import {
  initTelos,
  type Telos,
  type TelosTables,
} from "@decocms/telos/postgres";
import type { Kysely } from "kysely";
import { registerPursuitWorkflows } from "./durable/pursuit";
import { registerTelosCapabilities } from "./durable/registry";
import { setTelosRuntime } from "./durable/runtime";
import type { OnboardingTarget } from "./target";

export { initTelosDbos } from "./durable/queue";

// telos owns its storage (the `telos` schema); the cast is the one boundary
// where mesh's Kysely<Database> meets telos's own tables over the same Postgres.
const asTelos = (db: Kysely<Database>) => db as unknown as Kysely<TelosTables>;

let store: Telos<OnboardingTarget> | null = null;

// One call at app boot, before DBOS.launch(): migrate the telos schema, build
// the stores, stash deps for capability steps, and register durable capabilities.
export async function bootTelos(db: Kysely<Database>): Promise<void> {
  store = await initTelos<OnboardingTarget>({ db: asTelos(db) });
  setTelosRuntime({ db, store });
  registerTelosCapabilities();
  registerPursuitWorkflows();
}

export function telos(): Telos<OnboardingTarget> {
  if (!store) {
    throw new Error(
      "[telos] not initialized — bootTelos() must run at app boot",
    );
  }
  return store;
}
