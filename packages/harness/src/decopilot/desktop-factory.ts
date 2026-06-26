/**
 * desktop-factory — the import-isolated DESKTOP `HarnessFactory` registered in
 * the desktop daemon (`packages/sandbox/daemon/entry.ts`) under the id
 * "decopilot".
 *
 * The desktop runtime and the cluster runtime share ONE orchestration loop
 * (`runDecopilotCore`); the only difference is which `DecopilotToolRuntime` +
 * `telemetry` the environment builds. The unified cluster factory
 * (`./index.ts`) selects between `buildClusterEnvironmentTools` (cluster) and
 * `buildDesktopEnvironmentTools` (desktop) by inspecting the injected context —
 * but it statically imports the cluster assembler (`harness-deps.ts`, which
 * reaches `@/monitoring`, `@/tools/virtual/schema`, StudioContext, …). Pulling
 * that into the daemon bundle drags the whole cluster module graph in and the
 * bundle/`tsc` overflows.
 *
 * So the DAEMON imports THIS factory instead: it calls the SAME
 * `buildDesktopEnvironmentTools` desktop assembler (`./desktop-runtime.ts`),
 * but never references the cluster branch, so the daemon bundle stays free of
 * `@/*` / StudioContext. There is no behavioral fork — the desktop tool runtime
 * is single-sourced; this file is only the daemon's import-safe entrypoint into
 * it. (The cluster cutover onto the unified factory lands with
 * `createDesktopContext` in a later slice.)
 *
 * ⚠️ SECURITY: each `modelSources` slot (kind="secret") carries an org
 * chat-completion API key in plaintext over HTTPS. Never log it.
 */

import type { UIMessageChunk } from "ai";
import type {
  Harness,
  HarnessContext,
  HarnessFactory,
  HarnessStreamInput,
} from "../types";
import { createProviderFromSecret } from "./provider-from-secret";
import { createSideChannelWriter } from "../side-channel-writer";
import {
  buildModelRuntimeFromSources,
  runDecopilotCore,
  type ModelRuntime,
} from "./run-core";
import { buildDesktopEnvironmentTools } from "./desktop-runtime";
import { requireDecopilotRunContext } from "./run-context";

export const decopilotDesktopHarnessFactory: HarnessFactory = {
  id: "decopilot",
  create(_ctx: HarnessContext): Harness {
    return {
      id: "decopilot",
      async *stream(input: HarnessStreamInput): AsyncIterable<UIMessageChunk> {
        const { mcp } = input;
        const runContext = requireDecopilotRunContext(input);

        // ── Model runtime: providers from the resolved secret sources. Never
        //    log a modelSource — each carries a provider API key. ───────────
        const modelRuntime: ModelRuntime = buildModelRuntimeFromSources(
          { models: input.models, modelSources: runContext.modelSources },
          createProviderFromSecret,
        );

        // Diagnostics (provider id only, never the key). On the desktop this
        // runs inside the spawned daemon, so it surfaces in the link terminal.
        const thinkingSource = runContext.modelSources?.thinking;
        const providerId =
          thinkingSource?.kind === "secret" ? thinkingSource.providerId : "?";
        console.log(
          `[decopilot-desktop] stream start provider=${providerId} ` +
            `model=${input.models.thinking.id} mcpUrl=${mcp.url} mode=${input.mode}`,
        );

        // ── Per-run side-channel + MCP-client cleanup (desktop lifecycle). ──
        const sideChannel = createSideChannelWriter();
        // Captured inside buildEnvironmentTools so the finally below runs it
        // even if the core throws mid-stream.
        const cleanup: { close?: () => Promise<void> } = {};

        const toolRuntime = buildDesktopEnvironmentTools({
          input,
          modelRuntime,
          sideChannel,
          cleanup,
        });

        try {
          yield* runDecopilotCore({
            input,
            modelRuntime,
            toolRuntime,
            // Desktop runs stay OTel-invisible this phase (no monitoring sink).
            telemetry: undefined,
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
