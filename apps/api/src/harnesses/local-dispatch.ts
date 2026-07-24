import type { UIMessageChunk } from "ai";
import { getHarnessFactory } from "@decocms/harness/registry";
import type { HarnessId, HarnessStreamInput } from "@decocms/harness/types";
import type { StudioContext } from "../core/studio-context";

/** Invoke a harness in-process. Looks up the factory, creates a harness with
 *  the provided `ctx`, and returns its stream. Throws synchronously if the id
 *  is unknown.
 *
 *  This is the ONLY dispatch path for hosted (agent-sandbox / legacy)
 *  harnesses. User-desktop runs go through the PULL transport (work queue +
 *  daemon-side `handleLocalDispatch`), not in-process — the push
 *  `remoteDispatch` path was deleted (Transport Convergence). */
export function localDispatch(
  id: HarnessId,
  input: HarnessStreamInput,
  ctx: StudioContext,
): AsyncIterable<UIMessageChunk> {
  const factory = getHarnessFactory(id);
  if (!factory) {
    throw new Error(
      `No harness factory registered for id "${id}". Available ids must ` +
        `be registered in apps/api/src/harnesses/index.ts.`,
    );
  }
  return factory.create(ctx).stream(input);
}
