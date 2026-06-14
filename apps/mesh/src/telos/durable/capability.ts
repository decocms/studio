import type { TelosEventOf, TelosEventType } from "./events";
import type { TelosRuntime } from "./runtime";

// A Capability is a NAMED, VERSIONED, DURABLE reaction to a telos event — the
// `defineTool` of durability. You declare it; the registry owns every DBOS
// mechanic (registration, idempotent workflow IDs, journaled steps, recovery).
//
//   defineCapability({
//     name: "onboarding-research",
//     version: "v1",
//     on: "user.signup",
//     key: (e) => e.organizationId,   // → deterministic, idempotent workflow ID
//     run: async (event, { runtime, step }) => {
//       const r = await step("research", () => researchUser(event.email));
//       await step("persist", () => save(r));   // each step's result is journaled
//     },
//   })

export interface CapabilityCtx {
  runtime: TelosRuntime;
  /** Wraps `DBOS.runStep` — each step journals, so a crash resumes at the next. */
  step<R>(name: string, fn: () => Promise<R>): Promise<R>;
}

export interface CapabilityDef<K extends TelosEventType = TelosEventType> {
  /** Stable id → DBOS workflow name + workflow-ID prefix. */
  name: string;
  /** Bump to force a re-run after the body's logic changes (OAOO dedupes on id). */
  version: string;
  /** Which event triggers this capability. */
  on: K;
  /** Dedupe key from the event → the deterministic, idempotent workflow ID. */
  key: (event: TelosEventOf<K>) => string;
  run: (event: TelosEventOf<K>, ctx: CapabilityCtx) => Promise<void>;
}

// Collected at import time; the registry registers them all before launch.
export const CAPABILITIES: CapabilityDef[] = [];

export function defineCapability<K extends TelosEventType>(
  def: CapabilityDef<K>,
): CapabilityDef<K> {
  // The registry is heterogeneous over event types; each def is narrowed by its
  // own `on` and only ever invoked with a matching event (see registry).
  CAPABILITIES.push(def as unknown as CapabilityDef);
  return def;
}
