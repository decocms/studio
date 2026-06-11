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
import type { HarnessContext } from "../../core/harness-context";
import type { StudioContext } from "../../core/studio-context";
import type { Harness, HarnessFactory, HarnessStreamInput } from "../types";
import { createProviderFromSecret } from "./provider-from-secret";
import { createSideChannelWriter } from "../side-channel-writer";
import {
  buildModelRuntimeFromSources,
  runDecopilotCore,
  type DecopilotToolRuntime,
} from "./run-core";
import type { DecopilotTelemetry } from "./run-stream";
import { buildClusterEnvironmentTools } from "./harness-deps";
import { buildDesktopEnvironmentTools } from "./desktop-runtime";

/** True when the injected context is a full cluster `StudioContext` (it carries
 *  `storage`/`db`, absent from the bare `HarnessContext` the daemon builds). */
function isClusterContext(ctx: HarnessContext): ctx is StudioContext {
  return "storage" in ctx;
}

export const decopilotHarnessFactory: HarnessFactory = {
  id: "decopilot",
  create(harnessCtx: HarnessContext): Harness {
    return {
      id: "decopilot",
      async *stream(input: HarnessStreamInput): AsyncIterable<UIMessageChunk> {
        // ── Model runtime: providers from resolved secret sources (both
        //    environments use the same secret→provider factory). ────────────
        const modelRuntime = buildModelRuntimeFromSources(
          { models: input.models, modelSources: input.modelSources },
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
          const built = buildClusterEnvironmentTools({
            ctx: harnessCtx,
            organization: harnessCtx.organization!,
            modelRuntime,
            sideChannel,
            cleanup,
          });
          toolRuntime = built.toolRuntime;
          telemetry = built.telemetry;
        } else {
          // Desktop runs stay OTel-invisible this phase (no monitoring sink).
          toolRuntime = buildDesktopEnvironmentTools({
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
