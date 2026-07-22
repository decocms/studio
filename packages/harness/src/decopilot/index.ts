/**
 * Decopilot harness — the UNIFIED factory for the shared Decopilot core.
 *
 * The orchestration (processConversation → engine → streamText → title +
 * side-channel merge) lives in `runDecopilotCore` (`./run-core`). This factory
 * builds the cluster environment-deps bag:
 *
 *   - CLUSTER: when the injected `harnessCtx` carries a full `StudioContext`
 *     (`"storage" in harnessCtx`), build the StudioContext-backed deps via
 *     `buildClusterEnvironmentTools` — in-process virtual-MCP passthrough + the
 *     full cluster tool set (web_search / update_interests / Browserless
 *     built-ins) + the ctx-coupled `runAgentLoop` engine + cluster telemetry.
 * Created per-call (one `Harness` instance per stream) because the underlying
 * loop is stateful. The factory captures `ctx` so `HarnessStreamInput` stays
 * serializable for the remote transport. The per-run side-channel + MCP-client
 * cleanup is owned here (the `try/finally` below).
 */

import type { UIMessageChunk } from "ai";
import type {
  Harness,
  HarnessContext,
  HarnessFactory,
  HarnessStreamInput,
} from "../types";
import { createProviderFromSecret } from "./provider-from-secret";
import {
  createSideChannelWriter,
  type SideChannelWriter,
} from "../side-channel-writer";
import {
  buildModelRuntimeFromSources,
  runDecopilotCore,
  type DecopilotToolRuntime,
  type ModelRuntime,
} from "./run-core";
import { requireDecopilotRunContext } from "./run-context";
import type { DecopilotTelemetry } from "./run-stream";

/** True when the injected context is a full cluster context (it carries
 *  `storage`/`db`, absent from the bare `HarnessContext` the daemon builds).
 *  The cluster's richer `StudioContext` is structurally assignable to
 *  `HarnessContext`; the studio-side registered builder casts it back. */
function isClusterContext(ctx: HarnessContext): boolean {
  return "storage" in ctx;
}

// ── Environment-deps registration seam ──────────────────────────────────────
// The factory looks the cluster deps builder up from a module-scoped registry
// instead of statically importing the `@/`-coupled cluster assembler
// (`apps/mesh/src/harnesses/decopilot/harness-deps`). That keeps this package
// entry free of `@/` imports; the studio barrel registers the implementation.
export interface ClusterEnvironmentBuilderArgs {
  ctx: HarnessContext;
  modelRuntime: ModelRuntime;
  sideChannel: SideChannelWriter;
  cleanup: { close?: () => Promise<void> };
}
export type ClusterEnvironmentBuilder = (
  args: ClusterEnvironmentBuilderArgs,
) => {
  toolRuntime: DecopilotToolRuntime;
  telemetry?: DecopilotTelemetry;
};

let clusterEnvironmentBuilder: ClusterEnvironmentBuilder | undefined;

export function registerClusterEnvironmentBuilder(
  builder: ClusterEnvironmentBuilder,
): void {
  clusterEnvironmentBuilder = builder;
}

export const decopilotHarnessFactory: HarnessFactory = {
  id: "decopilot",
  create(harnessCtx: HarnessContext): Harness {
    return {
      id: "decopilot",
      async *stream(input: HarnessStreamInput): AsyncIterable<UIMessageChunk> {
        const runContext = requireDecopilotRunContext(input);
        // ── Model runtime: providers from resolved secret sources (both
        //    environments use the same secret→provider factory). ────────────
        const modelRuntime = buildModelRuntimeFromSources(
          { models: input.models, modelSources: runContext.modelSources },
          createProviderFromSecret,
        );

        // ── Per-run side-channel + MCP-client cleanup (shared lifecycle). ──
        const sideChannel = createSideChannelWriter();
        // The assembled tool bundle owns a live passthrough MCP client; the
        // factory must close it on completion/abort. Captured inside the
        // environment assembler's `buildEnvironmentTools` so the finally below
        // runs it even if the core throws mid-stream.
        const cleanup: { close?: () => Promise<void> } = {};

        if (!isClusterContext(harnessCtx)) {
          throw new Error("[decopilot] desktop dispatch is not supported");
        }
        if (!clusterEnvironmentBuilder) {
          throw new Error(
            "[decopilot] cluster environment builder not registered — " +
              "apps/mesh/src/harnesses must be imported before dispatching " +
              "the decopilot harness in cluster mode",
          );
        }
        const built = clusterEnvironmentBuilder({
          ctx: harnessCtx,
          modelRuntime,
          sideChannel,
          cleanup,
        });

        try {
          yield* runDecopilotCore({
            input,
            modelRuntime,
            toolRuntime: built.toolRuntime,
            telemetry: built.telemetry,
            kind: "main",
          });
        } finally {
          sideChannel.close();
          await cleanup.close?.().catch(() => {});
        }
      },
    };
  },
};
