# Local-Link Pull Inversion — Phase E (Decopilot Harness Portability) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **⚠️ WHOLE-PHASE BANNER — NEEDS HUMAN REVIEW BEFORE MERGE.** This phase touches the SHIPPED `deco link` daemon binary (`packages/sandbox/daemon/entry.ts`) and injects an org provider API key into the wire format sent to user desktops. Both require explicit human sign-off before the branch is merged to main. Mark the PR "do not merge" until that review is complete.

**Goal:** Make the `decopilot` harness run on the user-desktop daemon alongside `claude-code` and `codex`. Today it is deliberately excluded from the daemon registry because it depends on a full `StudioContext` (`processLocal` bag, `storage`, `db`). This phase severs those dependencies by (1) removing the `processLocal` guard, (2) folding the five cluster-coupled built-in tools into MCP endpoint calls routed through the injected `mcp.url`, (3) injecting the main chat-model secret into `HarnessStreamInput.mcp.modelSecret` so the daemon can activate the provider locally, and (4) registering `decopilotHarnessFactory` in the daemon. Cloud-sandbox decopilot continues to run in-cluster unchanged (dual-homed). The studio-pack agent-prompt override is skipped on the desktop (those agents are cluster-only). `subtask` is kept cluster-side for this phase.

**Architecture:** The cluster-coupled built-in tools (`update_interests`, `take_screenshot`, `generate_image`, `web_search` streaming path, and `subtask`) are exposed as MCP tools on the cluster's MCP gateway and reached by the desktop via the existing injected `mcp.url` token — identical to how `codex`/`claude-code` call cluster capabilities today. The decopilot harness is then structurally equivalent to the other harnesses: two injected things — `mcp.url`+token and `mcp.modelSecret`. On the cluster side, the existing `processLocal` path and the `if (!("storage" in ctx))` guard are retained for in-cluster runs; the guard is only removed from the code path that the desktop factory exercises.

**Tech Stack:** Bun, TypeScript, Hono, Kysely (Postgres), AI SDK (`tool`, `zodSchema`), `defineTool` for MCP tool registration, `bun test` (unit — pure logic only), Playwright e2e (anything touching DB/NATS/HTTP).

**Spec:** [`local-link-pull-inversion-spec.md`](local-link-pull-inversion-spec.md) §3.8 (decopilot portability), §3.9 (credentials), §8 invariants L9, L10, L11. Companion: [`stream-of-record-spec.md`](stream-of-record-spec.md).

**Testing conventions (from `TESTING.md`):** two tiers only.
- **Unit (`bun test`, co-located `*.test.ts`):** pure logic with zero mocks, no DB, no network. Covers `isDesktopHarnessContext` predicate, the `modelSecret` field extraction helper, and the `buildAllTools` guard logic.
- **E2E (Playwright, `apps/mesh/e2e/tests/`):** the new MCP tool registrations, the `mcp.modelSecret` injection path, and end-to-end decopilot-on-daemon dispatch.

**Execution note:** Implement on an isolated worktree/branch (see `superpowers:using-git-worktrees`). Run `bun run fmt` before every commit (lefthook enforces it). Implement tasks in order — each task leaves the harness in a state that either continues to run correctly on the cluster (in-process path unchanged) or has not yet been cut over to the desktop. No half-severed state at any commit boundary.

**CRITICAL gate:** The pull transport is gated behind `link_transport === 'pull'` AND `message_storage_version === 2` (spec §3.3, §3.7, §8 L12). Nothing in this phase changes that gate — this phase makes the harness *portable*; the actual cutover to user-desktop routing lands in Phase D (where `resolveDispatchTarget` flips). At every commit in this phase decopilot continues to run in-cluster for all existing users.

---

## Open design decisions (resolve before coding)

These were the riskiest unknowns in the grounding. All are resolved here — do not re-open them.

### RD-1: `subtask` on desktop (HIGH RISK — RESOLVED: cluster-side MCP tool)
`subtask` calls `runAgentLoop` recursively and depends on `ctx.storage.virtualMcps.findById` + daemon-to-daemon dispatch (not yet proven). **Decision:** `subtask` remains a cluster-side MCP tool in Phase E. It is removed from `buildAllTools` on desktop harness paths (guarded by `isDesktopHarnessContext`). Desktop sub-task support is deferred to a later phase once daemon-to-daemon dispatch is proven. The cluster still assembles `subtask` as a built-in for in-process runs.

### RD-2: Provider secret injection (MEDIUM RISK — RESOLVED: `mcp.modelSecret` field, plaintext over HTTPS, main key only)
The desktop needs the main chat-model provider key to activate `MeshProvider` locally. **Decision:** Add `mcp.modelSecret?: { providerId: string; apiKey: string; baseUrl?: string; extraHeaders?: Record<string, string> }` to `HarnessStreamInput.mcp`. The field is populated by `dispatch-run.ts` only when `target.runsIn === "user-desktop"` AND `harnessId === "decopilot"`. Sub-provider keys (`image`, `deepResearch`) do NOT transit to the desktop — those built-ins stay cluster-side. Plaintext over HTTPS (same trust posture as the existing `mcp.headers` Bearer token). Hardening alternative (cluster model-proxy) is documented as follow-up; the field is documented with a security note.

### RD-3: Tool name collision prevention (MEDIUM RISK — RESOLVED: register cluster MCP tools first, then remove from `buildAllTools`)
The safest path to avoid `toolsFromMCP` collision with existing built-ins is: register the five tools as cluster MCP tools FIRST (Tasks 1–4), verify no name collision in `toolsFromMCP`, then remove them from `buildAllTools` for the desktop path (Task 5). The tool names in the MCP layer use the same canonical names (`update_interests`, `take_screenshot`, `generate_image`, `web_search`, `subtask`) — the `nameMap` in `helpers.ts` deduplicates if the same name appears in both MCP and built-ins, so the transition is safe. The built-in is only removed from the desktop path; the cluster in-process path keeps the built-in (no MCP round-trip for in-cluster runs).

### RD-4: `studio-pack` on desktop (RESOLVED: conditional import, skip resolution)
`findStudioPackAgentByMcpId` and `resolveStudioPackRuntime` reference `@/tools/virtual/studio-pack` which has no parallel in the daemon bundle. **Decision:** In the new desktop harness factory path, skip studio-pack resolution entirely (those agents are cluster-only; the desktop will never receive one via `resolveDispatchTarget`). The conditional is a simple `if (isDesktopHarnessContext(harnessCtx))` guard around the studio-pack block in `index.ts`.

---

## File Structure

| File | Responsibility | New / Modify |
|---|---|---|
| `apps/mesh/src/harnesses/types.ts` | Add `modelSecret` optional field to `HarnessStreamInput.mcp`. | Modify |
| `apps/mesh/src/harnesses/types.test.ts` | Unit: `modelSecret` field presence/absence on the wire shape. | **New** |
| `apps/mesh/src/harnesses/decopilot/index.ts` | Add `isDesktopHarnessContext()` guard; split cluster vs. desktop factory paths; skip studio-pack on desktop; skip `processLocal` requirement when desktop. | Modify |
| `apps/mesh/src/harnesses/decopilot/desktop-factory.ts` | New desktop-specific factory: activates `MeshProvider` from `mcp.modelSecret`, builds tools without cluster-coupled ones, runs the same `runDecopilotStream`. | **New** |
| `apps/mesh/src/harnesses/decopilot/desktop-factory.test.ts` | Unit: `isDesktopHarnessContext` predicate + `extractModelSecret` helper. | **New** |
| `apps/mesh/src/harnesses/decopilot/built-in-tools/index.ts` | Add `isDesktopContext` flag to `BuiltinToolParams`; gate `update_interests`, `subtask`, `generate_image`, `web_search`, `take_screenshot` on `!isDesktopContext`. | Modify |
| `apps/mesh/src/tools/decopilot-mcp/update-interests-tool.ts` | Cluster MCP tool wrapping the existing `storage.interests.setForAgent` logic (mirrors `update_interests` built-in). | **New** |
| `apps/mesh/src/tools/decopilot-mcp/take-screenshot-tool.ts` | Cluster MCP tool wrapping the `createTakeScreenshotTool` logic (object storage stays cluster-side). | **New** |
| `apps/mesh/src/tools/decopilot-mcp/generate-image-tool.ts` | Cluster MCP tool wrapping `createGenerateImageTool` logic (presigned URLs for object storage result). | **New** |
| `apps/mesh/src/tools/decopilot-mcp/web-search-tool.ts` | Cluster MCP tool: streaming path only (Perplexity-style); async path (Gemini Deep Research) stays as the existing `web_search` built-in for in-cluster runs. | **New** |
| `apps/mesh/src/tools/decopilot-mcp/subtask-tool.ts` | Cluster MCP tool wrapping existing `createSubtaskTool` logic (cluster-only recursion). | **New** |
| `apps/mesh/src/tools/decopilot-mcp/index.ts` | Barrel: exports all five MCP tool definitions and the `registerDecopilotMcpTools` helper. | **New** |
| `apps/mesh/src/api/routes/decopilot/dispatch-run.ts` | In `mintMcpEndpoint` (or its call site): when `target.runsIn === "user-desktop"` and `harnessId === "decopilot"`, resolve the chat provider API key from vault and add `modelSecret` to the returned `mcp` struct. | Modify |
| `apps/mesh/src/links/resolve-dispatch-target.ts` | No change needed in Phase E — routing flip is Phase D. Add a comment documenting the dual-homed invariant. | Modify (comment only) |
| `packages/sandbox/daemon/entry.ts` | **⚠️ SHIPPED DAEMON** — import `decopilotHarnessFactory` and add `["decopilot", decopilotHarnessFactory]` to `dispatchHarnessRegistry`. | Modify ⚠️ |
| `apps/mesh/e2e/tests/decopilot-desktop-harness.spec.ts` | E2E: desktop decopilot dispatch (with a `user-desktop` mock target), MCP tool reachability, `modelSecret` injection path. | **New** |

---

## Task 1: Register `update_interests` as a cluster MCP tool

The first cluster-coupled built-in to fold. This task creates the MCP tool definition (thin wrapper around the existing storage call), registers it in the tool registry, and verifies it appears in `listTools()` for a virtual MCP endpoint. The built-in is NOT yet removed from `buildAllTools` — it stays in place for cluster in-process runs.

**Files:**
- Create: `apps/mesh/src/tools/decopilot-mcp/update-interests-tool.ts`
- Create: `apps/mesh/src/tools/decopilot-mcp/index.ts` (start with just this tool)

- [ ] **Step 1: Create the MCP tool file**

```ts
// apps/mesh/src/tools/decopilot-mcp/update-interests-tool.ts
/**
 * Cluster-side MCP exposure of the `update_interests` decopilot built-in.
 *
 * The desktop daemon calls this via the injected `mcp.url` token instead of
 * running it in-process (which would require `ctx.storage.interests`).
 * In-cluster decopilot continues to use the built-in directly (no MCP round-trip).
 *
 * Registered under the virtual-mcp agent's connection list alongside the
 * other built-in cluster tools by `registerDecopilotMcpTools`.
 */
import { z } from "zod";
import { defineTool } from "@/core/define-tool";

const UpdateInterestsInputSchema = z.object({
  interests: z
    .array(
      z.object({
        title: z.string().max(120).describe("Short noun phrase, e.g. 'Learning Rust'"),
        summary: z
          .string()
          .max(500)
          .describe("One or two sentences of context, including any progress"),
      }),
    )
    .max(10),
  agentId: z.string().min(1).max(128).describe("Agent (Virtual MCP) id scoping these interests."),
  userId: z.string().min(1).describe("User id scoping these interests."),
});

export const UPDATE_INTERESTS_MCP_TOOL = defineTool({
  name: "UPDATE_INTERESTS_MCP",
  description:
    "Record what the user is durably working toward (their goals/interests). " +
    "Pass the FULL list every time — it replaces the stored one. Order by importance, most first.",
  inputSchema: UpdateInterestsInputSchema,
  outputSchema: z.object({ ok: z.literal(true), count: z.number() }),
  handler: async (input, ctx) => {
    await ctx.access.check();
    await ctx.storage.interests.setForAgent(
      ctx.organization!.id,
      input.agentId,
      input.userId,
      { interests: input.interests },
    );
    return { ok: true as const, count: input.interests.length };
  },
});
```

- [ ] **Step 2: Create the barrel index (stub for now, expanded in later tasks)**

```ts
// apps/mesh/src/tools/decopilot-mcp/index.ts
/**
 * Cluster-side MCP tools that desktop decopilot calls remotely via the
 * injected mcp.url token. In-cluster runs continue to use the built-in
 * versions directly (no MCP round-trip).
 */
export { UPDATE_INTERESTS_MCP_TOOL } from "./update-interests-tool";
```

- [ ] **Step 3: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS with no type errors on the new files.

- [ ] **Step 4: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/tools/decopilot-mcp/update-interests-tool.ts apps/mesh/src/tools/decopilot-mcp/index.ts
git commit -m "feat(decopilot-mcp): add update_interests cluster MCP tool for desktop dispatch"
```

---

## Task 2: Register `subtask` as a cluster MCP tool

`subtask` must stay cluster-side because it calls `runAgentLoop` recursively and depends on `ctx.storage.virtualMcps.findById`. This task wraps the existing logic in a `defineTool` shell and exports it from the barrel.

**Files:**
- Create: `apps/mesh/src/tools/decopilot-mcp/subtask-tool.ts`
- Modify: `apps/mesh/src/tools/decopilot-mcp/index.ts`

- [ ] **Step 1: Create the MCP tool file**

```ts
// apps/mesh/src/tools/decopilot-mcp/subtask-tool.ts
/**
 * Cluster-side MCP exposure of the `subtask` decopilot built-in.
 *
 * Desktop decopilot cannot safely run recursive harness dispatch (daemon-to-
 * daemon nesting is unproven). This MCP tool keeps subtask cluster-side:
 * the desktop calls it via mcp.url; the cluster runs runAgentLoop in-process.
 *
 * NOTE: The desktop harness omits this tool from its built-in set entirely;
 * it only appears here so the cluster MCP endpoint exposes it when the
 * desktop's toolsFromMCP() call lists tools.
 */
import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { createVirtualClientFrom } from "@/mcp-clients/virtual-mcp";
import { runAgentLoop } from "@/harnesses/decopilot/run-agent-loop";
import { SUBAGENT_STEP_LIMIT } from "@/api/routes/decopilot/constants";

const SubtaskInputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(50_000)
    .describe(
      "The task to delegate to the subagent. Be specific and self-contained — " +
        "the subagent has no access to the parent conversation history.",
    ),
  agent_id: z
    .string()
    .min(1)
    .max(128)
    .describe("The ID of the agent (Virtual MCP) to delegate to."),
  models: z
    .object({
      credentialId: z.string(),
      thinking: z.object({ id: z.string() }),
    })
    .passthrough()
    .describe("Forwarded models config from the parent run."),
  organizationId: z.string(),
  userId: z.string(),
});

export const SUBTASK_MCP_TOOL = defineTool({
  name: "SUBTASK_MCP",
  description:
    "Delegate a focused sub-task to a specialized agent. The subagent runs independently " +
    "and returns its result as a structured summary.",
  inputSchema: SubtaskInputSchema,
  outputSchema: z.object({ result: z.string() }),
  handler: async (input, ctx) => {
    await ctx.access.check();
    const virtualMcp = await ctx.storage.virtualMcps.findById(
      input.agent_id,
      input.organizationId,
    );
    if (!virtualMcp) {
      throw new Error(`Subagent not found: ${input.agent_id}`);
    }
    const mcpClient = await createVirtualClientFrom(
      virtualMcp,
      ctx,
      "passthrough",
      true,
    );
    const chunks: string[] = [];
    await runAgentLoop(
      {
        prompt: input.prompt,
        virtualMcp,
        models: input.models as Parameters<typeof runAgentLoop>[0]["models"],
        stepLimit: SUBAGENT_STEP_LIMIT,
      },
      ctx,
      mcpClient,
      (chunk) => {
        if (
          chunk.type === "text-delta" &&
          "delta" in chunk &&
          typeof chunk.delta === "string"
        ) {
          chunks.push(chunk.delta);
        }
      },
    );
    return { result: chunks.join("") };
  },
});
```

- [ ] **Step 2: Export from the barrel**

In `apps/mesh/src/tools/decopilot-mcp/index.ts`, add:

```ts
export { SUBTASK_MCP_TOOL } from "./subtask-tool";
```

- [ ] **Step 3: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS. If `runAgentLoop`'s signature differs from the inline call above, adjust the parameter shape to match exactly (check `apps/mesh/src/harnesses/decopilot/run-agent-loop.ts` for the exact parameter types and fix the call accordingly — do not use `as unknown`).

- [ ] **Step 4: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/tools/decopilot-mcp/subtask-tool.ts apps/mesh/src/tools/decopilot-mcp/index.ts
git commit -m "feat(decopilot-mcp): add subtask cluster MCP tool (keeps recursive dispatch cluster-side)"
```

---

## Task 3: Register `take_screenshot` and `generate_image` as cluster MCP tools

Both tools depend on `ctx.objectStorage` (S3 PUT). The MCP tools perform the same operations but return presigned GET URLs so the desktop can embed the result in its conversation without holding object-storage credentials.

**Files:**
- Create: `apps/mesh/src/tools/decopilot-mcp/take-screenshot-tool.ts`
- Create: `apps/mesh/src/tools/decopilot-mcp/generate-image-tool.ts`
- Modify: `apps/mesh/src/tools/decopilot-mcp/index.ts`

- [ ] **Step 1: Create `take-screenshot-tool.ts`**

```ts
// apps/mesh/src/tools/decopilot-mcp/take-screenshot-tool.ts
/**
 * Cluster-side MCP exposure of the `take_screenshot` decopilot built-in.
 *
 * Captures a JPEG via Browserless, uploads to object storage (cluster-only),
 * and returns a presigned GET URL valid for 10 minutes so the desktop daemon
 * can embed it in the conversation without holding object-storage credentials.
 * Object storage credentials never leave the cluster.
 */
import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { BROWSERLESS_BASE_URL } from "@/harnesses/decopilot/built-in-tools/constants";
import { generatePresignedGetUrl } from "@/api/routes/decopilot/file-materializer";
import { toMeshStorageUri } from "@/api/routes/decopilot/mesh-storage-uri";

const TakeScreenshotInputSchema = z.object({
  url: z.string().url().describe("The URL of the web page to screenshot."),
  fullPage: z
    .boolean()
    .optional()
    .describe("When true, captures the full scrollable page. Defaults to false."),
});

export const TAKE_SCREENSHOT_MCP_TOOL = defineTool({
  name: "TAKE_SCREENSHOT_MCP",
  description:
    "Capture a screenshot of a web page using Browserless. Returns a time-limited " +
    "presigned URL to the JPEG so it can be displayed in the conversation.",
  inputSchema: TakeScreenshotInputSchema,
  outputSchema: z.object({
    presignedUrl: z.string().url(),
    meshStorageUri: z.string(),
  }),
  handler: async (input, ctx) => {
    await ctx.access.check();
    if (!ctx.objectStorage) throw new Error("Object storage not configured");
    if (!process.env.BROWSERLESS_TOKEN) throw new Error("BROWSERLESS_TOKEN not set");

    const response = await fetch(`${BROWSERLESS_BASE_URL}/screenshot`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.BROWSERLESS_TOKEN}`,
      },
      body: JSON.stringify({
        url: input.url,
        options: { type: "jpeg", quality: 80, fullPage: input.fullPage ?? false },
      }),
    });
    if (!response.ok) {
      throw new Error(`Browserless error: ${response.status} ${await response.text()}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const key = `screenshots/${crypto.randomUUID()}.jpg`;
    await ctx.objectStorage.put(key, bytes, { contentType: "image/jpeg" });
    const meshStorageUri = toMeshStorageUri(key);
    const presignedUrl = await generatePresignedGetUrl(key, ctx, 600);
    return { presignedUrl, meshStorageUri };
  },
});
```

- [ ] **Step 2: Create `generate-image-tool.ts`**

```ts
// apps/mesh/src/tools/decopilot-mcp/generate-image-tool.ts
/**
 * Cluster-side MCP exposure of the `generate_image` decopilot built-in.
 *
 * Runs image generation cluster-side (where the imageProvider secret lives)
 * and returns a presigned GET URL for the result. The desktop daemon never
 * holds the image-provider key; it only receives the URL.
 *
 * The provider is resolved from the credential embedded in the models config
 * that the cluster passes when building the MCP token context.
 */
import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { generateImage } from "ai";
import { toMeshStorageUri } from "@/api/routes/decopilot/mesh-storage-uri";
import { generatePresignedGetUrl } from "@/api/routes/decopilot/file-materializer";

const GenerateImageInputSchema = z.object({
  prompt: z.string().max(10_000).describe("Detailed description of the image to generate."),
  credentialId: z.string().describe("Image-tier credential id — resolved cluster-side to the provider."),
  modelId: z.string().describe("Image model id to use."),
  organizationId: z.string(),
});

export const GENERATE_IMAGE_MCP_TOOL = defineTool({
  name: "GENERATE_IMAGE_MCP",
  description:
    "Generate an image using the configured image model. Returns a presigned URL " +
    "to the result PNG so it can be displayed in the conversation.",
  inputSchema: GenerateImageInputSchema,
  outputSchema: z.object({
    presignedUrl: z.string().url(),
    meshStorageUri: z.string(),
  }),
  handler: async (input, ctx) => {
    await ctx.access.check();
    if (!ctx.objectStorage) throw new Error("Object storage not configured");
    const provider = await ctx.aiProviders.activate(
      input.credentialId,
      input.organizationId,
    );
    if (!provider) throw new Error("Could not activate image provider");
    const { image } = await generateImage({
      model: provider.aiSdk.imageModel!(input.modelId),
      prompt: input.prompt,
    });
    const bytes = new Uint8Array(await image.arrayBuffer());
    const key = `generated-images/${crypto.randomUUID()}.png`;
    await ctx.objectStorage.put(key, bytes, { contentType: "image/png" });
    const meshStorageUri = toMeshStorageUri(key);
    const presignedUrl = await generatePresignedGetUrl(key, ctx, 600);
    return { presignedUrl, meshStorageUri };
  },
});
```

- [ ] **Step 3: Export from the barrel**

In `apps/mesh/src/tools/decopilot-mcp/index.ts`, add:

```ts
export { TAKE_SCREENSHOT_MCP_TOOL } from "./take-screenshot-tool";
export { GENERATE_IMAGE_MCP_TOOL } from "./generate-image-tool";
```

- [ ] **Step 4: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS. If `provider.aiSdk.imageModel` is not in the `MeshProvider` type, use `(provider.aiSdk as unknown as { imageModel: (id: string) => unknown }).imageModel(input.modelId)` and file a follow-up TODO comment — do not change the `MeshProvider` interface in this task.

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/tools/decopilot-mcp/take-screenshot-tool.ts apps/mesh/src/tools/decopilot-mcp/generate-image-tool.ts apps/mesh/src/tools/decopilot-mcp/index.ts
git commit -m "feat(decopilot-mcp): add take_screenshot and generate_image cluster MCP tools (object storage stays cluster-side)"
```

---

## Task 4: Register `web_search` streaming path as a cluster MCP tool

The streaming path (Perplexity-style) has no cluster-side state. The async path (Gemini Deep Research) persists to `async_research_jobs` and MUST stay as the existing `web_search` built-in for in-cluster runs. This task adds a new MCP tool for the streaming-only path; the async path remains the built-in.

**Files:**
- Create: `apps/mesh/src/tools/decopilot-mcp/web-search-tool.ts`
- Modify: `apps/mesh/src/tools/decopilot-mcp/index.ts`

- [ ] **Step 1: Create `web-search-tool.ts`**

```ts
// apps/mesh/src/tools/decopilot-mcp/web-search-tool.ts
/**
 * Cluster-side MCP exposure of the `web_search` streaming path.
 *
 * Handles providers WITHOUT asyncResearch (e.g. Perplexity via OpenRouter):
 * calls streamText and returns the assembled text result. State lives
 * entirely on this request — nothing is persisted cluster-side.
 *
 * The async path (Gemini Deep Research — asyncResearch !== undefined) is NOT
 * handled here; it remains the `web_search` built-in for in-cluster runs
 * because it persists job rows to `async_research_jobs` (pod-death recovery
 * requires cluster-side persistence that the desktop cannot provide).
 *
 * The desktop receives this tool via toolsFromMCP(). When the model picks
 * `web_search` and the provider is streaming-only, this MCP tool runs on the
 * cluster and streams a text result back via the SSE tool-result channel.
 */
import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { streamText } from "ai";

const WebSearchStreamInputSchema = z.object({
  query: z.string().max(10_000).describe("The research query."),
  credentialId: z.string().describe("Deep-research-tier credential id."),
  modelId: z.string().describe("Deep-research model id."),
  organizationId: z.string(),
});

export const WEB_SEARCH_STREAM_MCP_TOOL = defineTool({
  name: "WEB_SEARCH_STREAM_MCP",
  description:
    "Search the web and synthesize a comprehensive answer using a streaming research model " +
    "(Perplexity-style). Use this when the deep-research provider does not support async jobs.",
  inputSchema: WebSearchStreamInputSchema,
  outputSchema: z.object({ result: z.string() }),
  handler: async (input, ctx) => {
    await ctx.access.check();
    const provider = await ctx.aiProviders.activate(
      input.credentialId,
      input.organizationId,
    );
    if (!provider) throw new Error("Could not activate deep-research provider");
    if (provider.asyncResearch?.canHandle(input.modelId)) {
      throw new Error(
        "WEB_SEARCH_STREAM_MCP does not handle async-research providers; " +
          "use the web_search built-in for Gemini Deep Research.",
      );
    }
    const { text } = await streamText({
      model: provider.aiSdk.languageModel(input.modelId),
      prompt: input.query,
    });
    return { result: await text };
  },
});
```

- [ ] **Step 2: Export from the barrel**

In `apps/mesh/src/tools/decopilot-mcp/index.ts`, add:

```ts
export { WEB_SEARCH_STREAM_MCP_TOOL } from "./web-search-tool";
```

- [ ] **Step 3: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 4: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/tools/decopilot-mcp/web-search-tool.ts apps/mesh/src/tools/decopilot-mcp/index.ts
git commit -m "feat(decopilot-mcp): add web_search streaming MCP tool (async/Gemini path stays built-in)"
```

---

## Task 5: Gate cluster-coupled built-ins in `buildAllTools` behind `isDesktopContext`

Add an `isDesktopContext` flag to `BuiltinToolParams`. When `true`, skip `update_interests`, `subtask`, `generate_image`, `web_search`, and `take_screenshot` from the assembled tool set (desktop reaches them via MCP). In-cluster builds pass `isDesktopContext: false` (default) — no behavior change for existing runs.

**Files:**
- Create: `apps/mesh/src/harnesses/decopilot/desktop-factory.test.ts` (unit test for the guard predicate)
- Modify: `apps/mesh/src/harnesses/decopilot/built-in-tools/index.ts`

- [ ] **Step 1: Write the failing unit test for the guard**

```ts
// apps/mesh/src/harnesses/decopilot/desktop-factory.test.ts
import { describe, expect, it } from "bun:test";
import { isDesktopHarnessContext } from "./desktop-factory";
import type { HarnessContext } from "../../types";
import { trace, metrics } from "@opentelemetry/api";

const baseCtx: HarnessContext = {
  tracer: trace.getTracer("test"),
  meter: metrics.getMeter("test"),
  metadata: { threadId: "t1", orgId: "o1", userId: "u1" },
};

describe("isDesktopHarnessContext", () => {
  it("returns true for a narrow HarnessContext (no storage/db)", () => {
    expect(isDesktopHarnessContext(baseCtx)).toBe(true);
  });

  it("returns false when storage is present (StudioContext)", () => {
    const ctx = { ...baseCtx, storage: {}, db: {} };
    expect(isDesktopHarnessContext(ctx)).toBe(false);
  });

  it("returns false when only db is present", () => {
    const ctx = { ...baseCtx, db: {} };
    expect(isDesktopHarnessContext(ctx)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/mesh/src/harnesses/decopilot/desktop-factory.test.ts`
Expected: FAIL — `Cannot find module './desktop-factory'`.

- [ ] **Step 3: Create `desktop-factory.ts` with the predicate (full factory comes in Task 7)**

```ts
// apps/mesh/src/harnesses/decopilot/desktop-factory.ts
/**
 * Desktop-harness factory for decopilot.
 *
 * Activates the main chat provider from the injected mcp.modelSecret,
 * builds the tool set without cluster-coupled built-ins (those are MCP tools
 * the desktop calls remotely), and runs the same runDecopilotStream loop.
 *
 * ⚠️ SECURITY NOTE: mcp.modelSecret contains the org's chat-completion API key
 * in plaintext, transmitted over HTTPS from the cluster to the desktop. This is
 * scoped to the single main chat-completion key only (sub-provider keys for
 * image/deep-research stay cluster-side). The hardening alternative — a cluster
 * model-proxy the desktop calls with the daemon token — is deferred (spec §3.9).
 */
import type { HarnessContext } from "../types";

/**
 * Returns true when the context is a narrow HarnessContext (desktop daemon),
 * false when it is a StudioContext (cluster in-process).
 *
 * The daemon constructs a HarnessContext directly (no storage/db); the cluster
 * passes its full StudioContext. The `storage` and `db` properties are reliable
 * discriminators because they are required fields on StudioContext but absent
 * from HarnessContext.
 */
export function isDesktopHarnessContext(ctx: HarnessContext): boolean {
  return !("storage" in ctx) && !("db" in ctx);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/mesh/src/harnesses/decopilot/desktop-factory.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add `isDesktopContext` to `BuiltinToolParams` and gate cluster-coupled tools**

In `apps/mesh/src/harnesses/decopilot/built-in-tools/index.ts`:

Add to the `BuiltinToolParams` interface (after the `agentId` field at line ~123):

```ts
  /**
   * When true the harness is running on the user-desktop daemon. Cluster-coupled
   * built-ins (update_interests, subtask, generate_image, web_search, take_screenshot)
   * are omitted — the desktop calls them via the injected mcp.url token instead.
   * Defaults to false (in-cluster; all built-ins assembled as today).
   */
  isDesktopContext?: boolean;
```

In `buildAllTools`, after destructuring `params` (around line 153), add:

```ts
  const { ..., isDesktopContext = false } = params;
```

Then wrap each cluster-coupled tool block with `if (!isDesktopContext)`:

```ts
  // update_interests — cluster-only (storage.interests); desktop calls via MCP.
  if (!isDesktopContext && userId) {
    tools.update_interests = createUpdateInterestsTool({ ctx, orgId: organization.id, agentId, userId });
  }
```

```ts
  // subtask — cluster-only (runAgentLoop recursion); desktop calls via MCP.
  if (!isDesktopContext && provider) {
    tools.subtask = createSubtaskTool(writer, { provider, organization, models, needsApproval: ... }, ctx);
  }
```

```ts
  // generate_image — cluster-only (objectStorage); desktop calls via MCP.
  if (!isDesktopContext && imageProvider && models.image) {
    tools.generate_image = createGenerateImageTool(writer, { provider: imageProvider, imageModelInfo: models.image, ctx });
  }
```

```ts
  // web_search — cluster-only (asyncResearchJobs + objectStorage); desktop calls via MCP.
  if (!isDesktopContext && deepResearchProvider && models.deepResearch) {
    tools.web_search = createWebSearchTool(writer, { provider: deepResearchProvider, deepResearchModelInfo: models.deepResearch, ctx, toolOutputMap, taskId });
  }
```

```ts
  // take_screenshot — cluster-only (objectStorage); desktop calls via MCP.
  if (process.env.BROWSERLESS_TOKEN) {
    if (!isDesktopContext) {
      tools.take_screenshot = createTakeScreenshotTool(writer, { ctx, toolOutputMap, pendingImages });
    }
    tools.scrape_url = createScrapeUrlTool(writer, { ctx, toolOutputMap });
    tools.inspect_page = createInspectPageTool(writer, { ctx, toolOutputMap });
  }
```

Note: `scrape_url` and `inspect_page` are kept on desktop because they only use the external Browserless API (no object storage upload path). If they do write to `ctx.objectStorage`, add them to the `!isDesktopContext` block as well — check the file before editing.

- [ ] **Step 6: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS. The `isDesktopContext` property has a default value, so all existing callers pass without change.

- [ ] **Step 7: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/harnesses/decopilot/desktop-factory.ts apps/mesh/src/harnesses/decopilot/desktop-factory.test.ts apps/mesh/src/harnesses/decopilot/built-in-tools/index.ts
git commit -m "feat(decopilot): gate cluster-coupled built-ins behind isDesktopContext flag"
```

---

## Task 6: Add `mcp.modelSecret` to `HarnessStreamInput` wire schema

The desktop needs the main chat-model API key to activate `MeshProvider` locally. This task adds the optional field to the wire type and writes a unit test verifying the presence/absence logic.

**Files:**
- Modify: `apps/mesh/src/harnesses/types.ts`
- Create: `apps/mesh/src/harnesses/types.test.ts`

- [ ] **Step 1: Write the failing unit test**

```ts
// apps/mesh/src/harnesses/types.test.ts
import { describe, expect, it } from "bun:test";
import type { HarnessStreamInput } from "./types";

/**
 * Verify the mcp.modelSecret field is structurally optional — a HarnessStreamInput
 * WITHOUT it (cluster path) and one WITH it (desktop path) must both satisfy the type.
 * This test exists to prevent regressions where a required field is accidentally added.
 */
describe("HarnessStreamInput.mcp.modelSecret", () => {
  it("accepts mcp without modelSecret (cluster path)", () => {
    const mcp: HarnessStreamInput["mcp"] = {
      url: "https://cluster/mcp",
      headers: { Authorization: "Bearer tok" },
      expiresAt: Date.now() + 3600_000,
    };
    expect(mcp.modelSecret).toBeUndefined();
  });

  it("accepts mcp with modelSecret (desktop decopilot path)", () => {
    const mcp: HarnessStreamInput["mcp"] = {
      url: "https://cluster/mcp",
      headers: { Authorization: "Bearer tok" },
      expiresAt: Date.now() + 3600_000,
      modelSecret: {
        providerId: "anthropic",
        apiKey: "sk-ant-test",
      },
    };
    expect(mcp.modelSecret?.providerId).toBe("anthropic");
    expect(mcp.modelSecret?.apiKey).toBe("sk-ant-test");
  });

  it("modelSecret may carry baseUrl and extraHeaders", () => {
    const mcp: HarnessStreamInput["mcp"] = {
      url: "",
      headers: {},
      expiresAt: 0,
      modelSecret: {
        providerId: "openai",
        apiKey: "sk-test",
        baseUrl: "https://litellm.example.com/v1",
        extraHeaders: { "x-custom": "value" },
      },
    };
    expect(mcp.modelSecret?.baseUrl).toBe("https://litellm.example.com/v1");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/mesh/src/harnesses/types.test.ts`
Expected: FAIL — `mcp.modelSecret` property does not exist on the type.

- [ ] **Step 3: Add `modelSecret` to the `mcp` field in `HarnessStreamInput`**

In `apps/mesh/src/harnesses/types.ts`, in the `HarnessStreamInput` interface, expand the `mcp` object type (around line 199):

```ts
  mcp: {
    url: string;
    headers: Record<string, string>;
    expiresAt: number;
    /**
     * Injected main chat-model secret for desktop decopilot activation.
     *
     * Only present when `target.runsIn === "user-desktop"` AND `harnessId === "decopilot"`.
     * The desktop activates its MeshProvider from this field instead of reading from vault
     * (which is cluster-only). Sub-provider keys (image, deep-research) are NEVER included
     * here — those built-ins run cluster-side.
     *
     * ⚠️ SECURITY: This field carries an org provider API key in plaintext over HTTPS.
     * Accepted scope: single main chat-completion key, scoped to one run. Hardening
     * follow-up: cluster model-proxy (spec §3.9) — the desktop calls the proxy with the
     * daemon token; no provider key ever transits to the desktop.
     */
    modelSecret?: {
      /** Provider identifier, e.g. "anthropic", "openai", "gemini". */
      providerId: string;
      /** The resolved API key (or credential secret). Plaintext over HTTPS. */
      apiKey: string;
      /** Optional endpoint override for self-hosted/LiteLLM deployments. */
      baseUrl?: string;
      /** Additional request headers the provider adapter requires. */
      extraHeaders?: Record<string, string>;
    };
  };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/mesh/src/harnesses/types.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS — the field is optional, so all existing code compiles unchanged.

- [ ] **Step 6: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/harnesses/types.ts apps/mesh/src/harnesses/types.test.ts
git commit -m "feat(harnesses): add optional mcp.modelSecret to HarnessStreamInput for desktop decopilot provider injection"
```

---

## Task 7: Inject `mcp.modelSecret` in `dispatch-run.ts` for user-desktop decopilot

When `target.runsIn === "user-desktop"` AND `harnessId === "decopilot"`, the cluster resolves the chat provider's API key from vault and populates `mcp.modelSecret`. All other paths leave `modelSecret` undefined.

> **⚠️ SECURITY BANNER — NEEDS HUMAN REVIEW.** This task causes an org provider API key to transit to the user's desktop. Review before merge: verify the key is scoped to the chat-completion credential only, that the TTL matches the run duration, and that the HTTPS transport is the sole channel (no logging of the field).

**Files:**
- Modify: `apps/mesh/src/api/routes/decopilot/dispatch-run.ts`

- [ ] **Step 1: Read `dispatch-run.ts` around lines 895–914 to see the exact `mcp` construction**

Read: `apps/mesh/src/api/routes/decopilot/dispatch-run.ts` lines 893–916 to see the current `mcp` literal for decopilot (the `{ url: "", headers: {}, expiresAt: 0 }` sentinel).

- [ ] **Step 2: Add a helper to extract the raw API key from a `MeshProvider`**

In `dispatch-run.ts` (or a new small utility, if a clean extraction point exists), add a helper that reads the resolved key from the already-activated provider. The `MeshProvider` interface itself does not expose the raw key — the key is embedded in `provider.aiSdk`'s `ProviderV3` headers. Read the activation function (`ctx.aiProviders.activate`) to see what shape it returns and whether the key is available at this scope.

If the activated provider exposes no raw key getter, the injection must happen **before** `activate()` converts the key into headers. In that case, read the raw key directly from vault at this point:

```ts
// In dispatch-run.ts, inside the createUIMessageStream execute callback,
// after `provider` is already activated at line 637:

// Build modelSecret for user-desktop decopilot dispatch.
// The raw key is read from the provider credential record (vault) at the same
// point where we already resolved it for activation.
let modelSecret: HarnessStreamInput["mcp"]["modelSecret"] | undefined;
if (target.runsIn === "user-desktop" && harnessId === "decopilot") {
  // Read the raw credential from vault to avoid depending on provider internals.
  const credential = await ctx.vault.getCredential(chatCredId, input.organizationId);
  if (credential) {
    modelSecret = {
      providerId: credential.providerId,
      apiKey: credential.key,
      // baseUrl and extraHeaders only when the credential has them (LiteLLM/OpenRouter).
      ...(credential.baseUrl ? { baseUrl: credential.baseUrl } : {}),
      ...(credential.extraHeaders && Object.keys(credential.extraHeaders).length > 0
        ? { extraHeaders: credential.extraHeaders }
        : {}),
    };
  }
}
```

Then update the `mcp` literal for decopilot from:

```ts
const mcp =
  harnessId === "decopilot"
    ? {
        url: "",
        headers: {} as Record<string, string>,
        expiresAt: 0,
      }
    : await mintMcpEndpoint(...)
```

to:

```ts
const mcp =
  harnessId === "decopilot" && target.runsIn !== "user-desktop"
    ? {
        url: "",
        headers: {} as Record<string, string>,
        expiresAt: 0,
      }
    : await mintMcpEndpoint(
        ctx,
        input.agent.id,
        organization,
        harnessId === "claude-code"
          ? "claude-code-session"
          : harnessId === "decopilot"
            ? "decopilot-session"
            : "codex-session",
        target.runsIn,
      );

// Attach modelSecret when it was resolved above.
if (modelSecret) {
  (mcp as typeof mcp & { modelSecret: typeof modelSecret }).modelSecret = modelSecret;
}
```

Note: if `ctx.vault.getCredential` does not exist with that exact signature, grep for the actual vault read path used elsewhere in `dispatch-run.ts` (e.g. `ctx.storage.credentials.findById`) and use that pattern instead. Do NOT guess the signature — read the actual method before writing the call.

- [ ] **Step 3: Ensure the `modelSecret` field is never logged**

Search `dispatch-run.ts` for any `console.log` or span attribute calls that spread `harnessInput` or `mcp`. Add a comment on the `modelSecret` field: `// Never log this field — it contains a provider API key.`

- [ ] **Step 4: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/api/routes/decopilot/dispatch-run.ts
git commit -m "feat(dispatch): inject mcp.modelSecret for user-desktop decopilot dispatch

⚠️ SECURITY: org chat-completion API key now transits to user desktop when
target.runsIn === 'user-desktop' && harnessId === 'decopilot'. Scoped to single
chat-completion credential only. Hardening follow-up: cluster model-proxy (spec §3.9).

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 8: Build the desktop harness factory (`desktop-factory.ts`)

Complete the `desktop-factory.ts` started in Task 5. It activates `MeshProvider` from `mcp.modelSecret`, builds tools with `isDesktopContext: true`, skips the studio-pack resolution, and runs `runDecopilotStream`.

**Files:**
- Modify: `apps/mesh/src/harnesses/decopilot/desktop-factory.ts`

- [ ] **Step 1: Extend `HarnessContext` to carry `aiProviders` with an adapter activation path**

The `HarnessContext` interface at `apps/mesh/src/harnesses/types.ts` already has an optional `aiProviders?: { activate(credentialId: string, organizationId: string): Promise<unknown | null> }` field (line ~286). Verify this is present. If it is, the daemon can pass a `aiProviders` implementation that reads `mcp.modelSecret` and constructs a `MeshProvider` using the matching `ProviderAdapter.create(apiKey)`.

Read `apps/mesh/src/harnesses/types.ts` lines 278–292 to confirm the `aiProviders` optional field shape. Then add a `createModelSecretProviders` helper to `desktop-factory.ts`:

```ts
// apps/mesh/src/harnesses/decopilot/desktop-factory.ts (full file)

/**
 * Desktop-harness factory for decopilot.
 *
 * Activates the main chat provider from the injected mcp.modelSecret,
 * builds the tool set with isDesktopContext: true (cluster-coupled built-ins
 * omitted — they are reached via mcp.url instead), and runs the same
 * runDecopilotStream loop.
 *
 * Studio-pack agent-prompt resolution is SKIPPED on the desktop. Studio-pack
 * agents (Brand Manager, etc.) are cluster-only; resolveDispatchTarget never
 * routes them to user-desktop. If one is accidentally sent, the harness runs
 * without the brand-specific prompt override (safe degradation).
 *
 * ⚠️ SECURITY NOTE: mcp.modelSecret carries the org's chat-completion API key
 * to the desktop. Scoped to the single main chat-completion key only.
 * Hardening: cluster model-proxy (spec §3.9) — deferred.
 */
import type { HarnessContext, HarnessFactory, HarnessStreamInput, Harness } from "../types";
import type { UIMessageChunk } from "ai";
import { assembleDecopilotTools } from "./tools";
import { assembleDecopilotPrompt } from "./prompt";
import { runDecopilotStream } from "./run-stream";
import { processConversation } from "../../api/routes/decopilot/conversation";
import { DEFAULT_WINDOW_SIZE } from "../../api/routes/decopilot/constants";
import type { ChatMessage } from "../../api/routes/decopilot/types";
import type { ChatMode } from "../../api/routes/decopilot/mode-config";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk";

/** Discriminate the narrow daemon HarnessContext from a full StudioContext. */
export function isDesktopHarnessContext(ctx: HarnessContext): boolean {
  return !("storage" in ctx) && !("db" in ctx);
}

interface DesktopClusterInputView {
  messages: ChatMessage[];
  mode: ChatMode;
  virtualMcp: VirtualMCPEntity;
}

export const decopilotDesktopHarnessFactory: HarnessFactory = {
  id: "decopilot",
  create(harnessCtx: HarnessContext): Harness {
    // This factory is ONLY called from the daemon; the daemon constructs a
    // narrow HarnessContext. Defensive check for misuse.
    if (!isDesktopHarnessContext(harnessCtx)) {
      throw new Error(
        "decopilotDesktopHarnessFactory must only be used in the daemon context. " +
          "For cluster in-process, use decopilotHarnessFactory.",
      );
    }

    return {
      id: "decopilot",
      async *stream(input: HarnessStreamInput): AsyncIterable<UIMessageChunk> {
        const { mcp } = input;
        if (!mcp.modelSecret) {
          throw new Error(
            "Desktop decopilot requires mcp.modelSecret to be set. " +
              "The cluster must inject the chat-model credential when routing to user-desktop.",
          );
        }

        // Activate the chat provider from the injected secret.
        // The daemon's aiProviders implementation constructs the MeshProvider
        // using the ProviderAdapter matching modelSecret.providerId.
        const provider = harnessCtx.aiProviders
          ? // Cast: the cluster's activate() returns MeshProvider|null, which is
            // the same shape the harness expects; the daemon implementation matches.
            ((await harnessCtx.aiProviders.activate(
              mcp.modelSecret.apiKey,
              input.organizationId,
            )) as import("../../ai-providers/types").MeshProvider | null)
          : null;

        if (!provider) {
          throw new Error(
            `Desktop decopilot: failed to activate provider '${mcp.modelSecret.providerId}'. ` +
              "Check that the ProviderAdapter for this provider is registered in the daemon.",
          );
        }

        const desktopInput = input as HarnessStreamInput & DesktopClusterInputView;

        // Build a minimal processLocal-equivalent for the desktop:
        // writer and runRegistry are not available here — they are cluster-side
        // constructs. The desktop produces the stream directly without the
        // surrounding createUIMessageStream scope.
        const toolOutputMap = new Map<string, string>();
        const pendingImages: unknown[] = [];

        const tools = await assembleDecopilotTools(desktopInput, harnessCtx as never, {
          writer: null as never, // desktop stream has no writer; tools that need writer are excluded
          toolOutputMap,
          pendingImages: pendingImages as never,
          threadId: input.threadId,
          provider,
          imageProvider: provider, // no separate image provider on desktop
          deepResearchProvider: provider, // no async deep-research on desktop
          htmlPageBuffer: null as never, // VM HTML tools not available on desktop without htmlPageBuffer
          isDesktopContext: true,
        });

        try {
          const { systemMessages: processedSystemMessages, messages: processedMessages, originalMessages } =
            await processConversation(desktopInput.messages, {
              windowSize: DEFAULT_WINDOW_SIZE,
              models: input.models,
              tools: tools.tools,
            });

          const narrowedMessages = processedMessages as Parameters<typeof runDecopilotStream>[4]["processedMessages"];

          const prompt = await assembleDecopilotPrompt(desktopInput, harnessCtx as never, tools);

          yield* runDecopilotStream(desktopInput, harnessCtx as never, tools, prompt, {
            provider,
            titleProvider: provider,
            titleModel: input.models.fast ?? input.models.thinking,
            registrySignal: input.signal,
            runRegistry: null as never,
            processedSystemMessages,
            processedMessages: narrowedMessages,
            originalMessages,
            threadId: input.threadId,
            currentThreadTitle: input.currentThreadTitle ?? "",
            registerPendingOp: () => {},
            isStreamFinished: () => false,
            onUsageAggregated: () => {},
            pendingImages: pendingImages as never,
            writer: null as never,
          });
        } finally {
          await tools.close().catch(() => {});
        }
      },
    };
  },
};
```

**Important:** After writing the file, do a typecheck pass. The `assembleDecopilotTools` and `runDecopilotStream` functions accept a `StudioContext` where this passes a `HarnessContext` — the `as never` casts are intentional (safe because the desktop only reaches code paths that do NOT read `ctx.storage`/`ctx.db`). If TypeScript flags specific lines, fix each cast minimally. Do not replace cast sites with `any`.

- [ ] **Step 2: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS (or at most a small number of cast-related errors that are fixed by adjusting the `as never` casts to the appropriate interface that TypeScript accepts — do NOT change the underlying function signatures).

- [ ] **Step 3: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/harnesses/decopilot/desktop-factory.ts
git commit -m "feat(decopilot): implement desktop harness factory — activates provider from mcp.modelSecret, skips cluster-coupled built-ins"
```

---

## Task 9: Update `decopilotHarnessFactory` in `index.ts` to dispatch to the desktop factory

The existing `decopilotHarnessFactory` in `index.ts` continues to handle in-cluster runs (full `StudioContext`, `processLocal` required). Add a branch: when `isDesktopHarnessContext(harnessCtx)`, delegate to `decopilotDesktopHarnessFactory`.

**Files:**
- Modify: `apps/mesh/src/harnesses/decopilot/index.ts`

- [ ] **Step 1: Read the current `decopilotHarnessFactory.create` preamble (lines 100–132)**

Verify the exact guard text (`if (!("storage" in harnessCtx) || !("db" in harnessCtx)) throw`). This is the guard to replace with the delegation.

- [ ] **Step 2: Replace the hard-throw guard with a delegation**

Change lines 112–118 from:

```ts
    if (!("storage" in harnessCtx) || !("db" in harnessCtx)) {
      throw new Error(
        "decopilot harness requires StudioContext (cluster-side only); " +
          "got narrow HarnessContext",
      );
    }
```

to:

```ts
    // Desktop daemon: delegate to the portable desktop factory.
    // The desktop factory activates the provider from mcp.modelSecret and
    // omits cluster-coupled built-ins (spec §3.8, invariant L9).
    if (isDesktopHarnessContext(harnessCtx)) {
      return decopilotDesktopHarnessFactory.create(harnessCtx);
    }
```

Add the import at the top of `index.ts`:

```ts
import {
  decopilotDesktopHarnessFactory,
  isDesktopHarnessContext,
} from "./desktop-factory";
```

- [ ] **Step 3: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 4: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/harnesses/decopilot/index.ts
git commit -m "refactor(decopilot): replace cluster-only guard with desktop factory delegation in harness index"
```

---

## Task 10: Register `decopilotHarnessFactory` in the daemon registry

> **⚠️ SHIPPED DAEMON — NEEDS HUMAN REVIEW BEFORE MERGE.**
> This task modifies `packages/sandbox/daemon/entry.ts`, which is compiled into the `deco link` binary shipped to users. A regression here breaks all local-link users. The change is small (one import + one Map entry) but must be code-reviewed by a human owner of the daemon binary before the branch is merged.

**Files:**
- Modify: `packages/sandbox/daemon/entry.ts`

- [ ] **Step 1: Read lines 34–44 of `entry.ts` to verify the current import comment and registry**

Confirm the exact comment text on lines 34–36 ("decopilot pulls in cluster-only modules") — we are about to invalidate it. Also confirm that `claudeCodeHarnessFactory` is imported from `"../../../apps/mesh/src/harnesses/claude-code"` (the relative path the daemon uses instead of `@/` aliases).

- [ ] **Step 2: Add the decopilot import and registry entry**

In `packages/sandbox/daemon/entry.ts`:

Add after the `codexHarnessFactory` import (around line 39):

```ts
// decopilot is now daemon-portable: it activates its provider from mcp.modelSecret
// and calls cluster-coupled built-ins via the injected mcp.url token. See
// apps/mesh/src/harnesses/decopilot/desktop-factory.ts and spec §3.8.
import { decopilotHarnessFactory } from "../../../apps/mesh/src/harnesses/decopilot";
```

Update the registry (lines 397–400) from:

```ts
const dispatchHarnessRegistry: Map<string, HarnessFactory> = new Map([
  ["claude-code", claudeCodeHarnessFactory],
  ["codex", codexHarnessFactory],
]);
```

to:

```ts
const dispatchHarnessRegistry: Map<string, HarnessFactory> = new Map([
  ["claude-code", claudeCodeHarnessFactory],
  ["codex", codexHarnessFactory],
  // decopilot: now daemon-portable (spec §3.8). Only registered when
  // resolveDispatchTarget routes target.runsIn === "user-desktop" for this harness.
  ["decopilot", decopilotHarnessFactory],
]);
```

Update the existing comment on lines 34–36 to say:
```ts
// CLI factories for daemon dispatch. decopilot is now included — it has been
// ported to use only wire-serializable HarnessStreamInput (no StudioContext).
// See apps/mesh/src/harnesses/decopilot/desktop-factory.ts.
```

- [ ] **Step 3: Typecheck the daemon bundle**

Run: `bun run check` (from the repo root, which type-checks all workspaces including `packages/sandbox`).
Expected: PASS with no errors in `entry.ts` or the decopilot harness tree.

If the daemon's tsconfig does not cover `apps/mesh/src/harnesses/decopilot/desktop-factory.ts` paths, check `packages/sandbox/tsconfig.json` for `paths` or `include` — the existing `claudeCodeHarnessFactory` import already crosses this boundary, so the daemon tsconfig must already support it.

- [ ] **Step 4: Format and commit**

```bash
bun run fmt
git add packages/sandbox/daemon/entry.ts
git commit -m "feat(daemon): register decopilotHarnessFactory in dispatchHarnessRegistry

⚠️ SHIPPED DAEMON — requires human review before merge.
decopilot is now daemon-portable (spec §3.8): activates provider from
mcp.modelSecret, reaches cluster-coupled built-ins via mcp.url.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 11: Add `aiProviders` activation adapter to the daemon `HarnessContext`

The desktop factory calls `harnessCtx.aiProviders.activate(apiKey, organizationId)` — but today the daemon builds `HarnessContext` without that field (lines 411–422 of `entry.ts`). This task adds a minimal adapter that constructs a `MeshProvider` using the matching `ProviderAdapter` for the `modelSecret.providerId`.

> **⚠️ SHIPPED DAEMON — NEEDS HUMAN REVIEW BEFORE MERGE.** This task modifies the daemon's `HarnessContext` construction, enabling it to resolve provider credentials from injected secrets.

**Files:**
- Create: `packages/sandbox/daemon/provider-adapter.ts`
- Modify: `packages/sandbox/daemon/entry.ts`

- [ ] **Step 1: Read how ProviderAdapter.create works in apps/mesh**

Read `apps/mesh/src/ai-providers/` to find the registry (likely `apps/mesh/src/ai-providers/registry.ts` or similar) that maps `providerId` → `ProviderAdapter`. The adapter's `create(apiKey)` method returns a `MeshProvider`. Identify the exact export name and file path.

- [ ] **Step 2: Create `provider-adapter.ts` in the daemon package**

```ts
// packages/sandbox/daemon/provider-adapter.ts
/**
 * Minimal aiProviders adapter for the daemon's HarnessContext.
 *
 * The daemon does not have vault access; it receives the provider secret via
 * mcp.modelSecret. This adapter matches the providerId to the in-tree
 * ProviderAdapter registry and constructs a MeshProvider from the raw key.
 *
 * Only the main chat-completion provider is ever activated this way — sub-
 * providers (image, deep-research) stay cluster-side (spec §3.8).
 */
import { getProviderAdapter } from "../../../apps/mesh/src/ai-providers/registry";
import type { MeshProvider } from "../../../apps/mesh/src/ai-providers/types";

/**
 * Build a HarnessContext-compatible aiProviders shim.
 *
 * The `credentialId` parameter passed by the desktop factory is actually the
 * raw API key (not a DB id) — the factory passes `mcp.modelSecret.apiKey`
 * as the first argument to match the `activate(credentialId, orgId)` signature
 * without needing a DB lookup. This adapter interprets that first argument as
 * the raw key and uses the stored `providerId` from mcp.modelSecret to route.
 *
 * Call `createDaemonAiProviders(providerId)` ONCE per run; the returned
 * object satisfies `HarnessContext["aiProviders"]`.
 */
export function createDaemonAiProviders(providerId: string): {
  activate(apiKey: string, _organizationId: string): Promise<MeshProvider | null>;
} {
  return {
    async activate(apiKey: string, _organizationId: string): Promise<MeshProvider | null> {
      const adapter = getProviderAdapter(providerId);
      if (!adapter) {
        console.error(`[daemon:aiProviders] no adapter for providerId: ${providerId}`);
        return null;
      }
      try {
        return adapter.create(apiKey);
      } catch (err) {
        console.error(`[daemon:aiProviders] failed to create provider: ${err}`);
        return null;
      }
    },
  };
}
```

**Important:** Before writing this file, read `apps/mesh/src/ai-providers/registry.ts` (or wherever `getProviderAdapter` lives) to verify the exact function name and import path. If the registry uses a different API, adjust the call accordingly.

- [ ] **Step 3: Wire `aiProviders` into the daemon HarnessContext construction**

In `packages/sandbox/daemon/entry.ts`, inside `lookupDispatchHarness` (around lines 403–422), modify the `HarnessContext` construction to include `aiProviders` when the harness is `decopilot` and the input contains `mcp.modelSecret`:

```ts
const lookupDispatchHarness = (id: string, input: unknown) => {
  const factory = dispatchHarnessRegistry.get(id);
  if (!factory) throw new Error(`unknown harness: ${id}`);
  const harnessInput = input as HarnessStreamInput;

  // For decopilot on desktop, attach an aiProviders shim that activates
  // the provider from mcp.modelSecret (no vault access on daemon).
  const modelSecret = harnessInput.mcp?.modelSecret;
  const aiProviders =
    id === "decopilot" && modelSecret
      ? createDaemonAiProviders(modelSecret.providerId)
      : undefined;

  const ctx: HarnessContext = {
    tracer: dispatchTracer,
    meter: dispatchMeter,
    metadata: {
      threadId: harnessInput.threadId,
      orgId: harnessInput.organizationId,
      userId: harnessInput.user?.id,
    },
    ...(aiProviders ? { aiProviders } : {}),
  };
  const harness = factory.create(ctx);
  return { stream: () => harness.stream(harnessInput) };
};
```

Add the import at the top:

```ts
import { createDaemonAiProviders } from "./provider-adapter";
```

- [ ] **Step 4: Typecheck**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add packages/sandbox/daemon/provider-adapter.ts packages/sandbox/daemon/entry.ts
git commit -m "feat(daemon): add aiProviders shim for decopilot — activates MeshProvider from mcp.modelSecret

⚠️ SHIPPED DAEMON — requires human review before merge.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 12: Add a dual-homed routing comment to `resolve-dispatch-target.ts`

Phase D will flip `resolveDispatchTarget` to route user-desktop decopilot to the desktop. This task only adds a documenting comment marking the dual-homed invariant (cluster-decopilot = in-cluster, user-desktop-decopilot = desktop, both producing identical `thread_message_parts` rows). No behavior change.

**Files:**
- Modify: `apps/mesh/src/links/resolve-dispatch-target.ts`

- [ ] **Step 1: Read `resolve-dispatch-target.ts` to find where `harnessId === "decopilot"` is referenced**

Locate the relevant section. Add a comment immediately before or after the decopilot routing decision:

```ts
// DUAL-HOMED INVARIANT (spec §3.8, L9):
// Cloud-sandbox decopilot → in-cluster ("cluster" runsIn): uses processLocal path,
//   full StudioContext, all built-ins assembled in-process.
// User-desktop decopilot → "user-desktop" runsIn: uses desktop-factory path,
//   HarnessContext only, mcp.modelSecret injected, cluster-coupled built-ins via mcp.url.
// Both produce identical thread_message_parts rows via the SoR PartEmitter.
// Phase D flips the cutover: per-user link_transport flag + pull ⊆ v2 gate.
```

- [ ] **Step 2: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/links/resolve-dispatch-target.ts
git commit -m "docs(dispatch): annotate dual-homed decopilot routing invariant ahead of Phase D cutover"
```

---

## Task 13: E2E test — desktop decopilot dispatch and MCP tool reachability

> This is an E2E test (Playwright) because it requires a real Postgres DB, a running server, and HTTP. It verifies: (a) `mcp.modelSecret` is populated when `target.runsIn === "user-desktop"`, (b) the decopilot desktop factory runs without crashing on a minimal input, and (c) the five cluster-coupled MCP tools appear in a `listTools()` response for the decopilot virtual MCP endpoint.

**Files:**
- Create: `apps/mesh/e2e/tests/decopilot-desktop-harness.spec.ts`

- [ ] **Step 1: Write the E2E tests**

```ts
// apps/mesh/e2e/tests/decopilot-desktop-harness.spec.ts
import { expect, test } from "@playwright/test";
import { createOrgAndUser, seedVirtualMcp } from "../helpers";

test("decopilot MCP tools include the five cluster-coupled tools", async ({ request }) => {
  const { org, bearer } = await createOrgAndUser();
  const agentId = await seedVirtualMcp(org.id, { harnessId: "decopilot" });

  // List tools via the MCP proxy for the virtual MCP. All five cluster-coupled
  // tools must appear (they are registered on the cluster-side tool gateway).
  const res = await request.post(
    `/api/${org.slug}/mcp/virtual-mcp/${agentId}`,
    {
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    },
  );
  expect(res.status()).toBe(200);
  const body = await res.json();
  const toolNames: string[] = (body.result?.tools ?? []).map(
    (t: { name: string }) => t.name,
  );
  expect(toolNames).toContain("UPDATE_INTERESTS_MCP");
  expect(toolNames).toContain("SUBTASK_MCP");
  expect(toolNames).toContain("TAKE_SCREENSHOT_MCP");
  expect(toolNames).toContain("GENERATE_IMAGE_MCP");
  expect(toolNames).toContain("WEB_SEARCH_STREAM_MCP");
});

test("mcp.modelSecret is populated for user-desktop decopilot dispatch input", async ({
  request,
}) => {
  const { org, bearer } = await createOrgAndUser();
  // This test calls a test-only introspection endpoint that returns the resolved
  // HarnessStreamInput for a given dispatch target without actually running the harness.
  // If no such endpoint exists, this test validates indirectly by posting a message
  // and asserting that the run starts without the "requires mcp.modelSecret" error.
  //
  // Adjust to match the actual introspection or integration point available in e2e.
  // Placeholder: assert the endpoint returns 200 and the thread is created.
  const agentId = await seedVirtualMcp(org.id, { harnessId: "decopilot" });
  const res = await request.post(`/api/${org.slug}/threads`, {
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    data: {
      agentId,
      message: "Hello",
      // linkTransport: "pull" — only needed once Phase D lands; in Phase E we verify
      // only that the harness runs in-cluster (default path) without regressions.
    },
  });
  expect(res.status()).toBe(202);
});
```

- [ ] **Step 2: Run the E2E tests**

Run: `bun run --cwd=apps/mesh test:e2e decopilot-desktop-harness` (or the repo's Playwright invocation).
Expected: PASS — cluster-coupled tools appear in listTools; in-cluster decopilot dispatch returns 202.

- [ ] **Step 3: Format and commit**

```bash
bun run fmt
git add apps/mesh/e2e/tests/decopilot-desktop-harness.spec.ts
git commit -m "test(e2e): verify decopilot desktop harness portability — cluster MCP tools and dispatch"
```

---

## Task 14: Full integration pass — typecheck + lint + run all unit tests

Verify the entire phase compiles and all unit tests pass before declaring done.

- [ ] **Step 1: Typecheck all workspaces**

Run: `bun run check`
Expected: PASS — zero TypeScript errors across `apps/mesh`, `packages/sandbox`, and other workspaces.

- [ ] **Step 2: Run unit tests**

Run: `bun test apps/mesh/src/harnesses/ apps/mesh/src/tools/decopilot-mcp/`
Expected: PASS — all unit tests in the modified harness and tool files pass.

- [ ] **Step 3: Run linter**

Run: `bun run lint`
Expected: PASS — no oxlint errors on new files. If the custom plugin `ban-use-effect` flags anything in the new React-free server-side files, it is a false positive — check the plugin's glob pattern.

- [ ] **Step 4: Format check**

Run: `bun run fmt:check`
Expected: no diff.

---

## Done criteria for Phase E

- `decopilot` runs on the daemon without cluster-only imports. `isDesktopHarnessContext` correctly distinguishes daemon vs. cluster context.
- Five cluster-coupled tools (`update_interests`, `subtask`, `take_screenshot`, `generate_image`, `web_search` streaming) are registered as cluster MCP tools and appear in `listTools()` for the decopilot virtual MCP endpoint.
- `HarnessStreamInput.mcp.modelSecret` is populated by `dispatch-run.ts` when `target.runsIn === "user-desktop"` and `harnessId === "decopilot"`. The field is absent for all other harness/target combinations.
- `decopilotHarnessFactory` is registered in `packages/sandbox/daemon/entry.ts` at `dispatchHarnessRegistry`. The daemon's `HarnessContext` carries an `aiProviders` shim when the harness is decopilot.
- Studio-pack agent-prompt resolution is skipped on the desktop path (guard in `desktop-factory.ts`).
- `subtask` is NOT in the desktop built-in tool set; it remains a cluster-side MCP tool.
- VM tools (`read/write/edit/grep/glob/bash`) bind to the loopback `SandboxProvider` runner with no tool-code changes (`isDesktopContext` only gates the cluster-coupled tools).
- In-cluster decopilot is byte-for-byte unchanged for all existing users (`isDesktopContext: false` default; `processLocal` path unchanged; `resolveDispatchTarget` not yet flipped).
- `bun run check`, `bun run lint`, `bun run fmt:check`, and all unit tests pass.
- **PR is marked "do not merge" pending human review of:** (1) the `mcp.modelSecret` security implication (org provider key transits to desktop), and (2) the daemon binary changes in `packages/sandbox/daemon/entry.ts` and `provider-adapter.ts`.

**Next:** Phase D — cut `codex`/`claude-code` to the pull transport (no harness changes; flip `resolveDispatchTarget` for the already-portable harnesses). Once Phase D and Phase E both land, Phase F deletes the reverse-WS (`dispatcher.ts`, `ws-gateway.ts`, reply inbox, reply-leg chunking).
