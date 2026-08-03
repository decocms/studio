/**
 * Hosted Decopilot stream.
 *
 * The shared core owns conversation processing and streaming. This adapter
 * builds its one StudioContext-backed environment: in-process virtual-MCP
 * passthrough, hosted tools, `runAgentLoop`, and telemetry. Per-run
 * side-channel and MCP-client cleanup are owned here.
 */

import type { UIMessageChunk } from "ai";
import type { StudioContext } from "@/core/studio-context";
import { buildHostedDecopilotEnvironment } from "@/harnesses/decopilot/harness-deps";
import type { DecopilotStreamInput } from "@/harnesses/lib/types";
import { createProviderFromSecret } from "@/harnesses/lib/decopilot/provider-from-secret";
import { createSideChannelWriter } from "@/harnesses/lib/side-channel-writer";
import {
  buildModelRuntimeFromSources,
  runDecopilotCore,
} from "@/harnesses/lib/decopilot/run-core";
import type { DecopilotRunContext } from "@/harnesses/lib/decopilot/run-context";

export async function* streamDecopilot(
  ctx: StudioContext,
  input: DecopilotStreamInput,
  runContext: DecopilotRunContext,
): AsyncIterable<UIMessageChunk> {
  const modelRuntime = buildModelRuntimeFromSources(
    { models: input.models, modelSources: runContext.modelSources },
    createProviderFromSecret,
  );

  const sideChannel = createSideChannelWriter();
  const cleanup: { close?: () => Promise<void> } = {};

  try {
    const built = buildHostedDecopilotEnvironment({
      ctx,
      modelRuntime,
      sideChannel,
      cleanup,
    });
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
