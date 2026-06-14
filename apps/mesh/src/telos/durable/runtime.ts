import type { Database } from "@/storage/types";
import type { Kysely } from "kysely";

// Deps a capability body needs at run time. Capabilities are registered BEFORE
// `DBOS.launch()`, when these aren't built yet — so the runtime is injected via
// a module-level pointer (wired by app boot) and read lazily inside steps. Same
// pattern as the other DBOS workflows (public-sets-sync, thread-gate, …).
export interface TelosRuntime {
  db: Kysely<Database>;
}

let runtime: TelosRuntime | null = null;

/** Wire deps for capability bodies. Safe to call before `DBOS.launch()`. */
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
