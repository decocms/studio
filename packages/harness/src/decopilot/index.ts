/**
 * Decopilot harness — the UNIFIED factory for the shared Decopilot core.
 *
 * The orchestration (processConversation → engine → streamText → title +
 * side-channel merge) lives in `runDecopilotCore` (`./run-core`). ONE loop
 * drives BOTH environments; this factory only selects which environment-deps
 * bag to build:
 *
 *   - CLUSTER: when the injected `harnessCtx` carries a full `StudioContext`
 *     (`"storage" in harnessCtx`), build the StudioContext-backed deps via
 *     `buildClusterEnvironmentTools` — in-process virtual-MCP passthrough + the
 *     full cluster tool set (web_search / update_interests / Browserless
 *     built-ins) + the ctx-coupled `runAgentLoop` engine + cluster telemetry.
 *   - DESKTOP: otherwise (the import-isolated daemon constructs a bare
 *     `HarnessContext`), build the desktop deps via
 *     `buildDesktopEnvironmentTools` — HTTP MCP passthrough + local built-ins +
 *     the portable `runNativeAgentLoopCore` engine, with `telemetry: undefined`.
 *
 * Created per-call (one `Harness` instance per stream) because the underlying
 * loop is stateful. The factory captures `ctx` so `HarnessStreamInput` stays
 * serializable for the remote transport. The per-run side-channel + MCP-client
 * cleanup is owned here (the `try/finally` below) for both environments.
 *
 * The desktop-fork factory (`harnesses/decopilot-desktop/`) is collapsed into
 * this unified factory; its remaining registration is dropped in a follow-up.
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
 *  `HarnessContext`; the mesh-side registered builder casts it back. */
function isClusterContext(ctx: HarnessContext): boolean {
  return "storage" in ctx;
}

// ── Environment-deps registration seam ──────────────────────────────────────
// The factory is environment-agnostic: it looks the cluster/desktop deps builder
// up from a module-scoped registry instead of statically importing the
// `@/`-coupled cluster assembler (`./harness-deps`) or the desktop runtime
// (`./desktop-runtime`, which reaches `@decocms/sandbox` via the desktop sandbox
// glue). That keeps this file — the `@decocms/harness/decopilot` entry — free of
// `@/` and `@decocms/sandbox` so it can move into the package. The mesh barrel
// (`apps/mesh/src/harnesses/index.ts`) registers both impls at import time,
// before any dispatch; every cluster dispatch path imports that barrel
// transitively, so the builder is present when `create().stream()` runs.
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

export interface DesktopEnvironmentBuilderArgs {
  input: HarnessStreamInput;
  modelRuntime: ModelRuntime;
  sideChannel: SideChannelWriter;
  cleanup: { close?: () => Promise<void> };
}
export type DesktopEnvironmentBuilder = (
  args: DesktopEnvironmentBuilderArgs,
) => DecopilotToolRuntime;

let clusterEnvironmentBuilder: ClusterEnvironmentBuilder | undefined;
let desktopEnvironmentBuilder: DesktopEnvironmentBuilder | undefined;

export function registerClusterEnvironmentBuilder(
  builder: ClusterEnvironmentBuilder,
): void {
  clusterEnvironmentBuilder = builder;
}
export function registerDesktopEnvironmentBuilder(
  builder: DesktopEnvironmentBuilder,
): void {
  desktopEnvironmentBuilder = builder;
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

        // ── Select the environment deps bag. ──────────────────────────────
        let toolRuntime: DecopilotToolRuntime;
        let telemetry: DecopilotTelemetry | undefined;
        if (isClusterContext(harnessCtx)) {
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
          toolRuntime = built.toolRuntime;
          telemetry = built.telemetry;
        } else {
          if (!desktopEnvironmentBuilder) {
            throw new Error(
              "[decopilot] desktop environment builder not registered",
            );
          }
          // Desktop runs stay OTel-invisible this phase (no monitoring sink).
          toolRuntime = desktopEnvironmentBuilder({
            input,
            modelRuntime,
            sideChannel,
            cleanup,
          });
          telemetry = undefined;
        }

        try {
          yield* runDecopilotCore({
            input,
            modelRuntime,
            toolRuntime,
            telemetry,
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
