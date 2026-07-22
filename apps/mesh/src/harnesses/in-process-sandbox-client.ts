import type { UIMessageChunk } from "ai";
import { localDispatch } from "./local-dispatch";
import type { SandboxClient } from "@decocms/sandbox/dispatch/sandbox-client";
import type { HarnessId, HarnessStreamInput } from "@decocms/harness/types";
import type { StudioContext } from "../core/studio-context";

/**
 * InProcessSandboxClient — the cluster (in-process) SandboxClient (spec §5.2/§5.3).
 *
 * STUDIO-OWNED: it closes over StudioContext, so it cannot live in
 * @decocms/sandbox. `dispatch(input)` runs the harness IN-PROCESS — a direct
 * call, no HTTP, no wire, no serialization (the cluster fast path is preserved).
 *
 * STEP 1a (this commit): a behavior-preserving wrapper. It delegates to the
 * existing `localDispatch(harnessId, input, ctx)` path UNCHANGED and returns the
 * same AsyncIterable<UIMessageChunk>, which studio's consumeHarnessStream consumes
 * with no adapter. The HarnessDeps merge (fs-hooks from AgentSandboxProvider,
 * cluster hooks built from StudioContext) is layered in later sub-steps (1b…);
 * `localDispatch` is then folded fully into this client (§5.4).
 */
export class InProcessSandboxClient implements SandboxClient {
  private readonly ctx: StudioContext;
  private readonly harnessId: HarnessId;

  constructor(args: { ctx: StudioContext; harnessId: HarnessId }) {
    this.ctx = args.ctx;
    this.harnessId = args.harnessId;
  }

  dispatch(input: HarnessStreamInput): AsyncIterable<UIMessageChunk> {
    // Behavior-preserving (§12 step 1a): identical to the prior call site
    // `localDispatch(harnessId, harnessInput, ctx)`. StudioContext is
    // structurally assignable to the HarnessContext that factory.create(ctx)
    // consumes (tracer/meter/metadata/aiProviders), so this is a no-op rewire.
    return localDispatch(this.harnessId, input, this.ctx);
  }
}
