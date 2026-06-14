import type { Database } from "@/storage/types";
import type { TelosStore } from "@decocms/telos/postgres";
import type { Kysely } from "kysely";
import type { Goal } from "../target";

// Capabilities register before DBOS.launch(), so deps are injected via a
// module-level pointer (wired by app boot) and read lazily inside steps.
export interface TelosRuntime {
  db: Kysely<Database>;
  store: TelosStore<Goal>;
}

let runtime: TelosRuntime | null = null;

export function setTelosRuntime(rt: TelosRuntime): void {
  runtime = rt;
}

export function requireTelosRuntime(): TelosRuntime {
  if (!runtime) {
    throw new Error(
      "[telos] runtime not initialized — setTelosRuntime() must run before a capability fires",
    );
  }
  return runtime;
}
