/**
 * Parity fixtures for the desktop Decopilot tool set (§12 "parity test, run
 * before 1-last").
 *
 * The desktop fork (`harnesses/decopilot-desktop/`) is GONE; the unified
 * factory's desktop assembler (`buildDesktopEnvironmentTools`,
 * `./desktop-runtime.ts`) is the only desktop path. Both builders below now
 * drive that SAME assembler, so the `expect(newKeys).toEqual(oldKeys)`
 * assertion in `desktop-parity.test.ts` is a regression LOCK on the unified
 * desktop tool-key set (paired with a hardcoded baseline list in the test).
 *
 * The fakes use a fake MCP `Client` returning empty tool/prompt/resource lists
 * (so the passthrough set is empty and the bundle's keys are exactly the desktop
 * local built-ins) — the MCP source is opened through the `openHttp` test seam
 * so no real network connection is made. The tool bundle is only inspected for
 * its KEYS; nothing is executed.
 */

import type { OpenedMcpSource } from "../sources";
import { buildModelRuntimeFromSources } from "./run-core";
import { buildDesktopEnvironmentTools } from "./desktop-runtime";
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

/** Assemble one turn's desktop tool bundle via the unified factory's desktop
 *  assembler and return its sorted tool-key set. */
async function buildDesktopToolKeys(
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

/** Builder 1 — historically the legacy desktop fork's wiring; now the unified
 *  factory's desktop assembler (the fork is deleted). Kept as a separate export
 *  so the parity test reads as a before/after regression lock. */
export async function buildDesktopToolKeysViaExistingAdapter(
  input: HarnessStreamInput,
): Promise<string[]> {
  return buildDesktopToolKeys(input);
}

/** Builder 2 — the unified factory's desktop assembler
 *  (`buildDesktopEnvironmentTools`). Same path as Builder 1; the
 *  `expect(newKeys).toEqual(oldKeys)` assertion locks the desktop tool set. */
export async function buildDesktopToolKeysViaUnifiedFactory(
  input: HarnessStreamInput,
): Promise<string[]> {
  return buildDesktopToolKeys(input);
}
