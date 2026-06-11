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
import { buildModelRuntimeFromSources } from "./run-core";
import { createProviderFromSecret } from "./provider-from-secret";
import { createSideChannelWriter } from "../side-channel-writer";
import type { HarnessStreamInput } from "../types";

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

/** Build the desktop tool runtime, assemble one turn's tool bundle, and return
 *  its sorted tool-key set. Shared by both builders below. */
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

  const toolRuntime = createDesktopToolRuntime({
    input,
    mcpSource,
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

/** Builder 1: the EXISTING desktop adapter (`createDesktopToolRuntime`). This
 *  captures the baseline tool-key set. */
export async function buildDesktopToolKeysViaExistingAdapter(
  input: HarnessStreamInput,
): Promise<string[]> {
  return buildDesktopToolKeys(input);
}

/** Builder 2: the UNIFIED factory's desktop deps. For THIS task it delegates to
 *  the same code path as the existing adapter (so the baseline is captured and
 *  green); Task 8 re-points it at the real unified path. */
export async function buildDesktopToolKeysViaUnifiedFactory(
  input: HarnessStreamInput,
): Promise<string[]> {
  return buildDesktopToolKeys(input);
}
