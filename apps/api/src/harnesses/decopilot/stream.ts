/**
 * Runs the in-process Decopilot harness with Studio's concrete cluster
 * dependencies. Coding-agent CLI harnesses run in the agent sandbox instead.
 */

import type { UIMessageChunk } from "ai";
import type { StudioContext } from "@/core/studio-context";
import type { HarnessStreamInput } from "@/harnesses/lib/types";
import { createProviderFromSecret } from "@/harnesses/lib/decopilot/provider-from-secret";
import { createSideChannelWriter } from "@/harnesses/lib/side-channel-writer";
import {
  buildModelRuntimeFromSources,
  runDecopilotCore,
} from "@/harnesses/lib/decopilot/run-core";
import { requireDecopilotRunContext } from "@/harnesses/lib/decopilot/run-context";
import { buildClusterEnvironmentTools } from "./harness-deps";

export async function* streamDecopilot(
  ctx: StudioContext,
  input: HarnessStreamInput,
): AsyncIterable<UIMessageChunk> {
  const runContext = requireDecopilotRunContext(input);
  const modelRuntime = buildModelRuntimeFromSources(
    { models: input.models, modelSources: runContext.modelSources },
    createProviderFromSecret,
  );

  const organization = ctx.organization;
  if (!organization) {
    throw new Error(
      "[decopilot] an organization-scoped Studio context is required",
    );
  }

  const sideChannel = createSideChannelWriter();
  const cleanup: { close?: () => Promise<void> } = {};
  const built = buildClusterEnvironmentTools({
    ctx,
    organization,
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
}
