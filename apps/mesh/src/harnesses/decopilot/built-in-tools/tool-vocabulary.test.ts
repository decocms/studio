/**
 * Tool Vocabulary Parity + Stub Behavior (plan Task 19)
 *
 * Pins the invariant from the harness-kernel-convergence spec ("Tool Vocabulary
 * And Stubs"): cluster and desktop Decopilot expose the SAME visible built-in
 * tool vocabulary (name sets equal). Cluster-only tools that have no real
 * desktop implementation are present on the desktop AS STUBS (via
 * `includeUnavailableClusterOnlyTools: true`) so the model sees an identical
 * tool surface on both sides; the stubs return a clear "cluster only" error.
 *
 * These are UNIT tests: pure construction + name-set comparison + stub throw.
 * No DB, no network, no StudioContext. The cluster `getBuiltInTools` /
 * `assembleDecopilotTools` builders require real I/O (StudioContext, providers,
 * `resolveSandboxProvider`) to enumerate, so — per the plan's explicit fallback
 * — we compare the BUILT-IN vocabulary layer the spec actually cares about:
 *   - the shared portable built-ins (`buildPortableBuiltInTools`), the ONLY
 *     layer where the cluster/desktop vocabulary diverges (stubs vs real), and
 *   - the shared VM + subtask builders (`createVmTools` / `createLocalSubtaskTool`),
 *     which are environment-SYMMETRIC by construction (one shared builder, same
 *     names on both sides — `read/write/edit/grep/glob/bash/copy_to_sandbox/
 *     share_with_user` + `subtask`).
 * Passthrough MCP tools are intentionally excluded: they are dynamic per-agent,
 * not "vocabulary".
 *
 * ─── Stub audit (the complete stub list per the spec requirement) ───────────
 * | Tool             | Desktop status              | Disposition                       |
 * |------------------|-----------------------------|-----------------------------------|
 * | web_search       | stub (throws "cluster only") | stays cluster-only (deep-research |
 * |                  |                             | provider + cluster Gemini API)    |
 * | update_interests | stub (throws "cluster only") | stays cluster-only (storage-backed|
 * |                  |                             | per-agent interests memory)       |
 * | subtask          | REAL (local, Task 18)       | done — local in-process spawn     |
 * | generate_image   | REAL (portable)             | done — portable image tool        |
 * | scrape_url       | REAL (portable Browserless) | done — portable                   |
 * | inspect_page     | REAL (portable Browserless) | done — portable                   |
 * | take_screenshot  | REAL (portable Browserless) | done — portable                   |
 *
 * Only `web_search` and `update_interests` are stubbed; both remain cluster-only
 * by design (cluster-side deps with no portable equivalent yet). All other
 * cluster tools have a real desktop implementation.
 */

import { describe, expect, it } from "bun:test";
import {
  createSandboxFsHooks,
  type SandboxProvider,
} from "@decocms/sandbox/provider";
import { buildPortableBuiltInTools } from "@decocms/harness/decopilot/built-in-tools/portable-built-ins";
import { createVmTools } from "@decocms/harness/decopilot/built-in-tools/vm-tools/index";
import { createLocalSubtaskTool } from "@decocms/harness/decopilot/built-in-tools/local-subtask";
import type { ModelsConfig } from "@decocms/harness/types";

const writer = {
  write: () => {},
  merge: async () => {},
  onError: () => {},
} as never;

const passthroughClient = {
  readResource: async () => ({ contents: [] }),
  getPrompt: async () => ({ messages: [] }),
  listTools: async () => ({ tools: [] }),
  callTool: async () => ({ content: [] }),
  listResources: async () => ({ resources: [] }),
  listPrompts: async () => ({ prompts: [] }),
} as never;

const models: ModelsConfig = {
  thinking: { id: "claude-test", credentialId: "cred_1" },
};

const inertRunner: SandboxProvider = {
  kind: "user-desktop",
  ensure: async () => ({ handle: "h", workdir: "/", previewUrl: null }),
  delete: async () => {},
  alive: async () => true,
  getPreviewUrl: async () => null,
  watchClaimLifecycle: async function* () {
    yield { kind: "ready" as const };
  },
  proxyDaemonRequest: async () => Response.json({}),
};

/** The shared VM + subtask builder names — environment-symmetric (one shared
 *  builder, identical names cluster + desktop). Enumerated inertly. */
function sharedVmAndSubtaskNames(): Set<string> {
  const vmTools = createVmTools({
    fs: createSandboxFsHooks(inertRunner, {
      ensureHandle: async () => "h",
      invalidateHandle: async () => {},
      canAutoRestart: false,
    }),
    toolOutputMap: new Map(),
    needsApproval: false,
    pendingImages: [],
    ctx: { baseUrl: "", organization: { id: "o", slug: "o" } } as never,
    threadId: "t",
    virtualMcpId: "agent-1",
  });
  // Construct the local subtask tool to assert the shared builder is callable
  // inertly (its name in the toolset is the static key "subtask").
  createLocalSubtaskTool({
    writer,
    selfAgentId: "agent-1",
    models,
    runSubtask: async () => ({
      text: "",
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }),
  });
  return new Set([...Object.keys(vmTools), "subtask"]);
}

/**
 * The DESKTOP visible built-in vocabulary: portable built-ins WITH stubs on
 * (`includeUnavailableClusterOnlyTools: true`) + image + Browserless tools +
 * the shared VM tools + the local subtask. This is exactly what `buildLocalTools`
 * + the desktop adapter assemble (minus dynamic passthrough tools).
 */
function buildDesktopBuiltInsForTest(): Set<string> {
  const portable = buildPortableBuiltInTools({
    writer,
    toolOutputMap: new Map(),
    passthroughClient,
    toolApprovalLevel: "auto",
    isPlanMode: true,
    includeUnavailableClusterOnlyTools: true,
    objectStorage: { put: async (key: string) => ({ key }) } as never,
    pendingImages: [],
    imageTool: {
      provider: { aiSdk: { imageModel: () => ({}) as never } },
      imageModelInfo: { id: "image-1" },
    },
  });
  return new Set([...Object.keys(portable), ...sharedVmAndSubtaskNames()]);
}

/**
 * The CLUSTER visible built-in vocabulary. The cluster's `buildAllTools` calls
 * the SAME portable builder for the shared base (without stubs — it has the real
 * tools), then adds REAL tools OUTSIDE it: `update_interests` (storage-backed),
 * `web_search` (deep-research), and `generate_image` (via `createGenerateImageTool`,
 * NOT passed into the portable builder on the cluster path). VM + subtask come
 * from the same shared builders. To reproduce the same NAME set without real I/O,
 * this helper instead hands `imageTool` to the portable builder so `generate_image`
 * lands in `portableBase` — the resulting NAMES match the cluster either way.
 */
function buildClusterBuiltInsForTest(): Set<string> {
  const portableBase = buildPortableBuiltInTools({
    writer,
    toolOutputMap: new Map(),
    passthroughClient,
    toolApprovalLevel: "auto",
    isPlanMode: true,
    // Cluster does NOT use the portable stubs — it has the real tools.
    includeUnavailableClusterOnlyTools: false,
    objectStorage: { put: async (key: string) => ({ key }) } as never,
    pendingImages: [],
    imageTool: {
      provider: { aiSdk: { imageModel: () => ({}) as never } },
      imageModelInfo: { id: "image-1" },
    },
  });
  return new Set([
    ...Object.keys(portableBase),
    // Cluster-only real tools added by `buildAllTools` outside the portable
    // builder (index.ts): update_interests (userId present) + web_search
    // (deep-research provider present).
    "update_interests",
    "web_search",
    ...sharedVmAndSubtaskNames(),
  ]);
}

describe("tool vocabulary parity", () => {
  it("cluster and desktop expose the same visible built-in tool vocabulary", () => {
    const clusterNames = buildClusterBuiltInsForTest();
    const desktopNames = buildDesktopBuiltInsForTest();
    expect([...desktopNames].sort()).toEqual([...clusterNames].sort());
  });

  it("the only divergence is the two cluster-only stubs (real on cluster, stub on desktop)", () => {
    // Desktop portable WITHOUT stubs must be missing exactly web_search +
    // update_interests vs the desktop set WITH stubs — pinning the stub list.
    const withStubs = new Set(
      Object.keys(
        buildPortableBuiltInTools({
          writer,
          toolOutputMap: new Map(),
          passthroughClient,
          toolApprovalLevel: "auto",
          isPlanMode: true,
          includeUnavailableClusterOnlyTools: true,
        }),
      ),
    );
    const withoutStubs = new Set(
      Object.keys(
        buildPortableBuiltInTools({
          writer,
          toolOutputMap: new Map(),
          passthroughClient,
          toolApprovalLevel: "auto",
          isPlanMode: true,
          includeUnavailableClusterOnlyTools: false,
        }),
      ),
    );
    const stubbed = [...withStubs].filter((n) => !withoutStubs.has(n)).sort();
    expect(stubbed).toEqual(["update_interests", "web_search"]);
  });
});

describe("stub behavior", () => {
  const desktopPortable = buildPortableBuiltInTools({
    writer,
    toolOutputMap: new Map(),
    passthroughClient,
    toolApprovalLevel: "auto",
    isPlanMode: false,
    includeUnavailableClusterOnlyTools: true,
  });

  it("web_search stub throws a clear 'cluster only' error", async () => {
    const webSearch = desktopPortable.web_search as unknown as {
      execute: (input: { query: string }) => Promise<unknown>;
    };
    await expect(
      webSearch.execute({ query: "latest TypeScript release" }),
    ).rejects.toThrow(/web_search is only available in cluster Decopilot/);
  });

  it("update_interests stub throws a clear 'cluster only' error", async () => {
    const updateInterests = desktopPortable.update_interests as unknown as {
      execute: (input: { interests: [] }) => Promise<unknown>;
    };
    await expect(updateInterests.execute({ interests: [] })).rejects.toThrow(
      /update_interests is only available in cluster Decopilot/,
    );
  });
});
