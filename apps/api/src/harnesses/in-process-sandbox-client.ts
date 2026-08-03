import type { UIMessageChunk } from "ai";
import type { SandboxClient } from "@decocms/sandbox/dispatch/sandbox-client";
import { decopilotHarnessFactory } from "@/harnesses/lib/decopilot/index";
import type { HarnessId, HarnessStreamInput } from "@/harnesses/lib/types";
import type { StudioContext } from "../core/studio-context";

/**
 * InProcessSandboxClient — the cluster (in-process) SandboxClient (spec §5.2/§5.3).
 *
 * STUDIO-OWNED: it closes over StudioContext, so it cannot live in
 * @decocms/sandbox. `dispatch(input)` runs the harness IN-PROCESS — a direct
 * call, no HTTP, no wire, no serialization (the cluster fast path is preserved).
 *
 * Decopilot is hard-wired (spec §5.4: `localDispatch` folded into this
 * client). It is the only harness the cluster can host — the CLI harnesses
 * (claude-code, codex) are rejected upstream by `assertHarnessRunsInCluster`
 * at the gate and again by `dispatchRunAndWait`; this guard is the last line.
 * The factory registry this used to consult was a Map with one entry.
 */
export class InProcessSandboxClient implements SandboxClient {
  private readonly ctx: StudioContext;
  private readonly harnessId: HarnessId;

  constructor(args: { ctx: StudioContext; harnessId: HarnessId }) {
    this.ctx = args.ctx;
    this.harnessId = args.harnessId;
  }

  dispatch(input: HarnessStreamInput): AsyncIterable<UIMessageChunk> {
    if (this.harnessId !== "decopilot") {
      throw new Error(
        `InProcessSandboxClient runs cluster-hosted decopilot only; got ` +
          `"${this.harnessId}" — CLI harnesses run in the desktop app or are ` +
          `rejected at the gate`,
      );
    }
    // StudioContext is structurally assignable to the HarnessContext that
    // factory.create(ctx) consumes (tracer/meter/metadata/aiProviders).
    return decopilotHarnessFactory.create(this.ctx).stream(input);
  }
}
