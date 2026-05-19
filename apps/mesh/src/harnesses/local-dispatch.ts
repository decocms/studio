import type { UIMessageChunk } from "ai";
import type { MeshContext } from "../core/mesh-context";
import { getHarnessFactory } from "./registry";
import type { HarnessId, HarnessStreamInput } from "./types";

/** Invoke a harness in-process. Looks up the factory, creates a harness with
 *  the provided `ctx`, and returns its stream. Throws synchronously if the id
 *  is unknown.
 *
 *  A future `remoteDispatch(id, input, runnerId)` will live alongside this
 *  function; a top-level `dispatch()` will pick local vs remote based on
 *  runner config (out of scope here). */
export function localDispatch(
  id: HarnessId,
  input: HarnessStreamInput,
  ctx: MeshContext,
): AsyncIterable<UIMessageChunk> {
  const factory = getHarnessFactory(id);
  if (!factory) {
    throw new Error(
      `No harness factory registered for id "${id}". Available ids must ` +
        `be registered in apps/mesh/src/harnesses/index.ts.`,
    );
  }
  return factory.create(ctx).stream(input);
}
