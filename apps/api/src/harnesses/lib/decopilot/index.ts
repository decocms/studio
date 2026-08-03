/**
 * Hosted Decopilot stream for the shared Decopilot core.
 *
 * The orchestration (processConversation → engine → streamText → title +
 * side-channel merge) lives in `runDecopilotCore` (`./run-core`). This stream
 * builds the cluster environment-deps bag:
 *
 *   - CLUSTER: when the injected `harnessCtx` carries a full `StudioContext`
 *     (`"storage" in harnessCtx`), build the StudioContext-backed deps via
 *     `buildClusterEnvironmentTools` — in-process virtual-MCP passthrough + the
 *     full cluster tool set (web_search / update_interests / Browserless
 *     built-ins) + the ctx-coupled `runAgentLoop` engine + cluster telemetry.
 * Invoked once per run because the underlying loop is stateful. Context stays
 * separate from `DecopilotStreamInput`. The per-run side-channel + MCP-client
 * cleanup is owned here (the `try/finally` below).
 */

import type { UIMessageChunk } from "ai";
import type { DecopilotStreamInput, HarnessContext } from "../types";
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
import type { DecopilotRunContext } from "./run-context";
import type { DecopilotTelemetry } from "./run-stream";

/** True when the injected context is a full cluster context (it carries
 *  `storage`/`db`, absent from the portable `HarnessContext` contract).
 *  The cluster's richer `StudioContext` is structurally assignable to
 *  `HarnessContext`; the studio-side registered builder casts it back. */
function isClusterContext(ctx: HarnessContext): boolean {
  return "storage" in ctx;
}

// ── Environment-deps registration seam ──────────────────────────────────────
// The stream looks the cluster deps builder up from a module-scoped registry
// instead of statically importing the `@/`-coupled cluster assembler
// (`apps/api/src/harnesses/decopilot/harness-deps`). That keeps this package
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

export async function* streamDecopilot(
  harnessCtx: HarnessContext,
  input: DecopilotStreamInput,
  runContext: DecopilotRunContext,
): AsyncIterable<UIMessageChunk> {
  // ── Model runtime: providers from resolved secret sources (both
  //    environments use the same secret→provider factory). ────────────
  const modelRuntime = buildModelRuntimeFromSources(
    { models: input.models, modelSources: runContext.modelSources },
    createProviderFromSecret,
  );

  // ── Per-run side-channel + MCP-client cleanup (shared lifecycle). ──
  const sideChannel = createSideChannelWriter();
  // The assembled tool bundle owns a live passthrough MCP client. Capture
  // its cleanup inside the environment assembler so the finally below
  // runs it even if the core throws mid-stream.
  const cleanup: { close?: () => Promise<void> } = {};

  if (!isClusterContext(harnessCtx)) {
    throw new Error("[decopilot] a hosted Studio context is required");
  }
  if (!clusterEnvironmentBuilder) {
    throw new Error(
      "[decopilot] cluster environment builder not registered — " +
        "apps/api/src/harnesses must be imported before dispatching " +
        "the decopilot stream in cluster mode",
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
      runContext,
      modelRuntime,
      toolRuntime: built.toolRuntime,
      telemetry: built.telemetry,
      kind: "main",
    });
  } finally {
    sideChannel.close();
    await cleanup.close?.().catch(() => {});
  }
}
