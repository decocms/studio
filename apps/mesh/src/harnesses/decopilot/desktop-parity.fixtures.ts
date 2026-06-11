/**
 * Parity fixtures for the desktop Decopilot tool set (§12 "parity test, run
 * before 1-last").
 *
 * Both builders drive `createDesktopToolRuntime(...).buildEnvironmentTools(...)`
 * — the narrow seam that assembles the desktop tool bundle (passthrough MCP
 * tools + local built-ins). For THIS task both delegate to the SAME existing
 * desktop adapter, capturing its tool-key set as the green baseline the unified
 * factory (Task 8) must preserve. When Task 8 lands,
 * `buildDesktopToolKeysViaUnifiedFactory` re-points at the unified path and the
 * `expect(newKeys).toEqual(oldKeys)` assertion guards the cutover.
 *
 * The fakes mirror `decopilot-desktop/local-tools.test.ts`: a fake MCP `Client`
 * returning empty tool/prompt/resource lists (so the passthrough set is empty
 * and the bundle's keys are exactly the desktop local built-ins) and a fake
 * `SandboxProvider` runner (never actually exercised — only tool KEYS are read,
 * not executed). The MCP source is opened through the `openHttp` test seam so no
 * real network connection is made.
 */

import type { OpenedMcpSource } from "../sources";
import {
  createDesktopToolRuntime,
  resolveDesktopRuntimeSources,
} from "../decopilot-desktop/index";
import { swapVirtualMcpAgent } from "../decopilot-desktop/swap-virtual-mcp-agent";
import {
  buildModelRuntimeFromSources,
  spawnSubtask,
  type RunDecopilotCoreDeps,
  type SubtaskRunResult,
} from "./run-core";
import { buildDesktopEnvironmentTools } from "./harness-deps";
import { createLocalSubtaskTool } from "./built-in-tools/local-subtask";
import { createProviderFromSecret } from "./provider-from-secret";
import { createSideChannelWriter } from "../side-channel-writer";
import type { DecopilotHttpMcpSource, HarnessStreamInput } from "../types";

/** A fake MCP `Client` returning empty listings — the desktop passthrough set
 *  is therefore empty, so the assembled tool keys are exactly the desktop
 *  local built-ins. Cast to the structural shape `buildEnvironmentTools`
 *  consumes (`listTools`, `getInstructions`, …). */
function createFakeMcpClient(): OpenedMcpSource {
  const client = {
    listTools: async () => ({ tools: [] }),
    listPrompts: async () => ({ prompts: [] }),
    listResources: async () => ({ resources: [] }),
    readResource: async () => ({ contents: [] }),
    getPrompt: async () => ({ messages: [] }),
    callTool: async () => ({ content: [] }),
    getInstructions: () => undefined,
    close: async () => {},
  } as never;
  return { client, close: async () => {} };
}

/** Build the desktop tool runtime the way the LEGACY desktop factory's `stream`
 *  does — including the real desktop-local `subtask` tool (self + cross-agent) —
 *  assemble one turn's tool bundle, and return its sorted tool-key set. Mirrors
 *  `decopilot-desktop/index.ts` so the baseline reflects the legacy factory's
 *  full tool set (which the unified factory must reproduce exactly). */
async function buildDesktopToolKeys(
  input: HarnessStreamInput,
): Promise<string[]> {
  const { mcpSource } = resolveDesktopRuntimeSources(input);
  const modelRuntime = buildModelRuntimeFromSources(
    { models: input.models, modelSources: input.modelSources },
    createProviderFromSecret,
  );
  const sideChannel = createSideChannelWriter();
  const cleanup: { close?: () => Promise<void> } = {};

  // Legacy desktop factory's subtask wiring (decopilot-desktop/index.ts).
  const runSubtask = async (
    prompt: string,
    targetAgentId: string | undefined,
    signal: AbortSignal,
  ): Promise<SubtaskRunResult> => {
    const targetUrl = swapVirtualMcpAgent(mcpSource.url, targetAgentId);
    const targetMcpSource: DecopilotHttpMcpSource = {
      kind: "http",
      url: targetUrl,
      headers: mcpSource.headers,
      expiresAt: mcpSource.expiresAt,
    };
    const subSideChannel = createSideChannelWriter();
    const subCleanup: { close?: () => Promise<void> } = {};
    const targetInput: HarnessStreamInput = targetAgentId
      ? {
          ...input,
          agent: { id: targetAgentId },
          virtualMcp: { ...input.virtualMcp, id: targetAgentId },
        }
      : input;
    const targetToolRuntime = createDesktopToolRuntime({
      input: targetInput,
      mcpSource: targetMcpSource,
      modelRuntime,
      sideChannel: subSideChannel,
      cleanup: subCleanup,
      agentOverride: targetAgentId ? { id: targetAgentId } : undefined,
      openHttp: async () => createFakeMcpClient(),
    });
    const deps: Omit<RunDecopilotCoreDeps, "kind"> = {
      input: targetInput,
      modelRuntime,
      toolRuntime: targetToolRuntime,
      telemetry: undefined,
    };
    try {
      return await spawnSubtask({ prompt, deps, signal });
    } finally {
      subSideChannel.close();
      await subCleanup.close?.().catch(() => {});
    }
  };

  const subtaskTool = createLocalSubtaskTool({
    writer: sideChannel.writer,
    selfAgentId: input.agent.id,
    models: input.models,
    needsApproval: input.mode === "plan" || input.toolApprovalLevel !== "auto",
    runSubtask,
    onChildUsage: () => {},
  });

  const toolRuntime = createDesktopToolRuntime({
    input,
    mcpSource,
    modelRuntime,
    sideChannel,
    cleanup,
    subtask: subtaskTool,
    openHttp: async () => createFakeMcpClient(),
  });

  try {
    const bundle = await toolRuntime.buildEnvironmentTools({ input });
    return Object.keys(bundle.tools).sort();
  } finally {
    sideChannel.close();
    await cleanup.close?.().catch(() => {});
  }
}

/** Builder 1: the EXISTING (legacy) desktop factory wiring. This captures the
 *  baseline tool-key set — including the desktop-local `subtask` tool. */
export async function buildDesktopToolKeysViaExistingAdapter(
  input: HarnessStreamInput,
): Promise<string[]> {
  return buildDesktopToolKeys(input);
}

/** Builder 2: the UNIFIED factory's desktop deps. Constructs the desktop
 *  `DecopilotToolRuntime` via the unified factory's `buildDesktopEnvironmentTools`
 *  assembler (`harness-deps.ts`) and reads the same tool-key set. The
 *  `expect(newKeys).toEqual(oldKeys)` assertion guards the cutover. */
export async function buildDesktopToolKeysViaUnifiedFactory(
  input: HarnessStreamInput,
): Promise<string[]> {
  const modelRuntime = buildModelRuntimeFromSources(
    { models: input.models, modelSources: input.modelSources },
    createProviderFromSecret,
  );
  const sideChannel = createSideChannelWriter();
  const cleanup: { close?: () => Promise<void> } = {};

  const toolRuntime = buildDesktopEnvironmentTools({
    input,
    modelRuntime,
    sideChannel,
    cleanup,
    openHttp: async () => createFakeMcpClient(),
  });

  try {
    const bundle = await toolRuntime.buildEnvironmentTools({ input });
    return Object.keys(bundle.tools).sort();
  } finally {
    sideChannel.close();
    await cleanup.close?.().catch(() => {});
  }
}
