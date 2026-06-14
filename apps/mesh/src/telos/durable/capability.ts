import type { TelosEventOf, TelosEventType } from "./events";
import type { TelosRuntime } from "./runtime";

// A named, versioned, durable reaction to a telos event. The registry owns the
// DBOS mechanics (registration, idempotent workflow IDs, journaled steps).
export interface CapabilityCtx {
  runtime: TelosRuntime;
  /** Wraps DBOS.runStep — each step journals, so a crash resumes at the next. */
  step<R>(name: string, fn: () => Promise<R>): Promise<R>;
}

export interface CapabilityDef<K extends TelosEventType = TelosEventType> {
  name: string;
  /** Bump to force a re-run after the body changes (OAOO dedupes on id). */
  version: string;
  on: K;
  /** Dedupe key from the event → the deterministic, idempotent workflow ID. */
  key: (event: TelosEventOf<K>) => string;
  run: (event: TelosEventOf<K>, ctx: CapabilityCtx) => Promise<void>;
}

export const CAPABILITIES: CapabilityDef[] = [];

export function defineCapability<K extends TelosEventType>(
  def: CapabilityDef<K>,
): CapabilityDef<K> {
  CAPABILITIES.push(def as unknown as CapabilityDef);
  return def;
}
