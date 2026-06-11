/**
 * Decopilot Built-in Tools
 *
 * Client-side and server-side tools for decopilot agent interactions.
 * These use AI SDK tool() function and are registered directly in the decopilot API.
 */

import type { StudioContext, OrganizationScope } from "@/core/studio-context";
import { posthog } from "@/posthog";
import type { UIMessageStreamWriter } from "ai";
import {
  toolNeedsApproval,
  type ToolApprovalLevel,
} from "@decocms/harness/decopilot/mcp-tools";

// Known destructive/read-only classifications for built-in tools. Mirrors
// the MCP annotations used by passthrough tools so dashboards can filter
// uniformly across both sources.
const BUILTIN_TOOL_ANNOTATIONS: Record<
  string,
  { readOnly?: boolean; destructive?: boolean }
> = {
  read_tool_output: { readOnly: true, destructive: false },
  read_resource: { readOnly: true, destructive: false },
  read_prompt: { readOnly: true, destructive: false },
  web_search: { readOnly: true, destructive: false },
  generate_image: { readOnly: false, destructive: false },
  open_in_agent: { readOnly: false, destructive: false },
  subtask: { readOnly: false, destructive: false },
  user_ask: { readOnly: true, destructive: false },
  propose_plan: { readOnly: true, destructive: false },
  enable_tool: { readOnly: true, destructive: false },
  todo_write: { readOnly: false, destructive: false },
  update_interests: { readOnly: false, destructive: false },
};
import { createReadToolOutputTool } from "@decocms/harness/decopilot/built-in-tools/read-tool-output";
import { createReadPromptTool } from "@decocms/harness/decopilot/built-in-tools/prompts";
import { createReadResourceTool } from "@decocms/harness/decopilot/built-in-tools/resources";
import {
  createSandboxTool,
  type VirtualClient,
} from "@decocms/harness/decopilot/built-in-tools/sandbox";
import { createVmTools } from "@decocms/harness/decopilot/built-in-tools/vm-tools/index";
import type { HtmlPageBuffer } from "./vm-tools/html-page-buffer";
import { buildClusterSandboxFs } from "./cluster-sandbox-fs";
import { createSubtaskTool } from "./subtask";
import { userAskTool } from "@decocms/harness/decopilot/built-in-tools/user-ask";
import { todoWriteTool } from "@decocms/harness/decopilot/built-in-tools/todo-write";
import { createUpdateInterestsTool } from "@decocms/harness/decopilot/built-in-tools/update-interests";
import { proposePlanTool } from "@decocms/harness/decopilot/built-in-tools/propose-plan";
import { createGenerateImageTool } from "./generate-image";
import { createWebSearchTool } from "@decocms/harness/decopilot/built-in-tools/web-search";
import { createClusterResearchJob } from "./cluster-research-job";
import {
  createTakeScreenshotTool,
  type PendingImage,
} from "@decocms/harness/decopilot/built-in-tools/take-screenshot";
import { createScrapeUrlTool } from "@decocms/harness/decopilot/built-in-tools/scrape-url";
import { createInspectPageTool } from "@decocms/harness/decopilot/built-in-tools/inspect-page";
import { buildPortableBuiltInTools } from "@decocms/harness/decopilot/built-in-tools/portable-built-ins";
import { BROWSERLESS_BASE_URL } from "@decocms/harness/decopilot/built-in-tools/constants";
import type { ModelsConfig } from "@decocms/harness/types";
import type { MeshProvider } from "@/ai-providers/types";
import { getSettings } from "@/settings";

/**
 * Identifies the (virtual MCP, branch, user) tuple that the built-in VM
 * tools should bind to. Provisioning is lazy — the VM is only ensured on
 * the first VM-tool invocation.
 */
export type VmContext = {
  virtualMcpId: string;
  branch: string;
  userId: string;
  /**
   * Current chat thread id. Used by `share_with_user` to scope artifacts
   * under `model-outputs/<threadId>/`. Required because one ephemeral
   * sandbox serves multiple threads of the same (user, agent), so the
   * thread isn't deducible from the sandbox identity alone.
   */
  threadId: string;
};

export interface BuiltinToolParams {
  /** Provider — null for Claude Code (subtask tool is omitted when null) */
  provider: MeshProvider | null;
  /** Provider used to instantiate `generate_image`. Caller passes the
   *  chat provider when the org's `image` tier shares the chat credential
   *  (or no tier is configured) — otherwise a separately-activated
   *  provider matching the image-tier credential. */
  imageProvider: MeshProvider | null;
  /** Provider used to instantiate `web_search`'s deep-research path.
   *  Same aliasing rule as `imageProvider`. Decoupling from the chat
   *  provider lets web_search keep using a Gemini deep-research model
   *  even when the chat is routed via LiteLLM/OpenRouter. */
  deepResearchProvider: MeshProvider | null;
  organization: OrganizationScope;
  models: ModelsConfig;
  toolApprovalLevel?: ToolApprovalLevel;
  /** When true (chat mode `plan`), include `propose_plan` and plan-style approvals */
  isPlanMode?: boolean;
  toolOutputMap: Map<string, string>;
  passthroughClient: VirtualClient;
  /**
   * Images captured by take_screenshot, queued for injection as user
   * messages by prepareStep in dispatch-run.ts. This approach works
   * across all providers (including OpenRouter) since images in tool
   * result messages aren't universally supported.
   */
  pendingImages: PendingImage[];
  /**
   * When set, the six VM file tools (read/write/edit/grep/glob/bash) are
   * registered with a memoized lazy provisioner: the first tool call
   * triggers `ensureSandbox`, subsequent calls reuse the same handle.
   * When null, no VM-backed code execution tool is included.
   */
  vmContext?: VmContext | null;
  /**
   * Per-turn coalescing buffer for `pages/<slug>.html` writes. Created once
   * per run in the dispatch layer; the VM tools enqueue here and the
   * dispatch layer flushes (and emits the UI signal) at step-end so a
   * burst of edits collapses to one S3 PUT.
   */
  htmlPageBuffer: HtmlPageBuffer;
  /** Thread (task) id of the current run — needed by tools that persist
   *  thread-scoped state (e.g. web_search reconnecting to Gemini Deep Research). */
  taskId: string;
  /** Current agent (virtual MCP) id — scopes the per-agent interests memory
   *  written by `update_interests`. */
  agentId: string;
  /** Usage roll-up sink (Task 17) — forwarded to the `subtask` tool so a
   *  delegated child run's tokens fold into the parent run's accumulator. */
  onChildUsage?: (usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }) => void;
}

export type { PendingImage };

/**
 * Full tool set type — always includes propose_plan so that ChatMessage
 * (derived via ReturnType) can render historical plan parts regardless
 * of the current chat mode.
 */
export type BuiltInToolSet = Awaited<ReturnType<typeof buildAllTools>>;

async function buildAllTools(
  writer: UIMessageStreamWriter,
  params: BuiltinToolParams,
  ctx: StudioContext,
) {
  const {
    provider,
    imageProvider,
    deepResearchProvider,
    organization,
    models,
    toolApprovalLevel = "auto",
    isPlanMode = false,
    toolOutputMap,
    pendingImages,
    passthroughClient,
    vmContext,
    htmlPageBuffer,
    taskId,
    agentId,
    onChildUsage,
  } = params;
  const approvalOpts = { isPlanMode };
  const userId = ctx.auth?.user?.id;
  const tools: Record<string, unknown> = buildPortableBuiltInTools({
    writer,
    toolOutputMap,
    passthroughClient,
    toolApprovalLevel,
    isPlanMode,
    objectStorage: ctx.objectStorage,
  });
  if (userId) {
    // Cluster `interests.write` hook: closes over ctx/storage and forwards the
    // org/agent/user carried in the InterestsWrite payload. The tool itself no
    // longer touches StudioContext (HarnessDeps conversion).
    tools.update_interests = createUpdateInterestsTool({
      write: async (input) => {
        await ctx.storage.interests.setForAgent(
          input.orgId,
          input.agentId,
          input.userId,
          { interests: input.interests },
        );
      },
      orgId: organization.id,
      agentId,
      userId,
    });
  }
  // VM file tools — six LLM-visible tools (read/write/edit/grep/glob/bash)
  // always registered when a vmContext is provided. The handle is resolved
  // lazily on the first tool invocation: `ensureSandbox` either reuses
  // the existing sandboxMap entry (fast path) or provisions a new sandbox via
  // the env-selected runner. The promise is memoized on the closure so
  // parallel first calls (e.g. the model emitting bash + read in one step)
  // share a single provisioning round-trip.
  const vmNeedsApproval =
    toolNeedsApproval(toolApprovalLevel, false, approvalOpts) !== false;
  if (vmContext) {
    // The flat fs hooks (provider resolution + lazy handle + auto-restart retry
    // layer) are built by the cluster glue so the portable tools never import
    // `@decocms/sandbox` (spec §4.3). Provisioning stays lazy inside the hooks —
    // `ensureSandbox` runs on the first VM-tool call, not here.
    const fs = await buildClusterSandboxFs(ctx, {
      virtualMcpId: vmContext.virtualMcpId,
      branch: vmContext.branch,
      userId: vmContext.userId,
    });
    Object.assign(
      tools,
      createVmTools({
        fs,
        htmlPageBuffer,
        toolOutputMap,
        needsApproval: vmNeedsApproval,
        pendingImages,
        ctx,
        threadId: vmContext.threadId,
        virtualMcpId: vmContext.virtualMcpId,
      }),
    );
  }
  // subtask requires a provider (LLM calls) — skip when provider is null (Claude Code).
  if (provider) {
    tools.subtask = createSubtaskTool(
      writer,
      {
        provider,
        organization,
        models,
        // Pass the caller's own agent id so the model can clone itself by
        // omitting agent_id (heavy discovery → fresh, isolated context).
        self: { id: agentId },
        needsApproval:
          toolNeedsApproval(toolApprovalLevel, false, approvalOpts) !== false,
        // Roll the child run's usage into the parent's accumulator (Task 17).
        onChildUsage,
      },
      ctx,
    );
  }
  // generate_image requires a provider and an image model selection.
  // The provider is picked from `imageProvider` so the org can pair the
  // image tier with a different credential than the chat tier (caller
  // aliases it to `provider` when they share a credential).
  if (imageProvider && models.image && ctx.objectStorage) {
    // Cluster builds the `objectStorage` + `allowHttpExternalUrls` hooks from
    // StudioContext + settings; the tool itself no longer reads either
    // (HarnessDeps conversion).
    tools.generate_image = createGenerateImageTool(writer, {
      provider: imageProvider,
      imageModelInfo: models.image,
      objectStorage: ctx.objectStorage,
      allowHttpExternalUrls: getSettings().localMode,
    });
  }
  // web_search consumes the cluster-built `researchJob` async-gen hook
  // (HarnessDeps conversion, spec §6). The provider/DB lifecycle lives in
  // `createClusterResearchJob`; the tool only drives the generator. The hook
  // is built from `deepResearchProvider` so the deep-research tier can use
  // Gemini's async research API even when the chat model is served by another
  // provider (e.g. LiteLLM). Hook presence is the gate — desktop omits it and
  // `web_search` is simply not in the set (§5.1).
  if (deepResearchProvider && models.deepResearch) {
    const researchJob = createClusterResearchJob({
      provider: deepResearchProvider,
      deepResearchModelInfo: models.deepResearch,
      ctx,
    });
    tools.web_search = createWebSearchTool(writer, {
      researchJob,
      toolOutputMap,
      taskId,
    });
  }
  // take_screenshot, scrape_url, inspect_page require Browserless API token.
  if (process.env.BROWSERLESS_TOKEN) {
    // Cluster builds the `browserless` + `objectStorage` hooks; the tools
    // themselves no longer read ctx or process.env (HarnessDeps conversion).
    // The Browserless gate stays env-based — `deps.browserless` presence
    // equals `!!process.env.BROWSERLESS_TOKEN` as set by the cluster hook.
    const browserless = {
      baseUrl: BROWSERLESS_BASE_URL,
      token: process.env.BROWSERLESS_TOKEN,
    };
    // take_screenshot keeps its nullable objectStorage (it has a data-URI
    // fallback when storage is unavailable).
    tools.take_screenshot = createTakeScreenshotTool(writer, {
      objectStorage: ctx.objectStorage,
      toolOutputMap,
      pendingImages,
    });
    // scrape_url / inspect_page require non-null objectStorage (the cluster's
    // `deps.objectStorage` is universal). Object storage is effectively always
    // present in the cluster; guard so the non-null hook type holds.
    if (ctx.objectStorage) {
      tools.scrape_url = createScrapeUrlTool(writer, {
        browserless,
        objectStorage: ctx.objectStorage,
        toolOutputMap,
      });
      tools.inspect_page = createInspectPageTool(writer, {
        browserless,
        objectStorage: ctx.objectStorage,
        toolOutputMap,
      });
    }
  }
  return tools as {
    user_ask: typeof userAskTool;
    todo_write: typeof todoWriteTool;
    propose_plan: typeof proposePlanTool;
    update_interests: ReturnType<typeof createUpdateInterestsTool>;
    subtask: ReturnType<typeof createSubtaskTool>;
    read_tool_output: ReturnType<typeof createReadToolOutputTool>;
    sandbox: ReturnType<typeof createSandboxTool>;
    read_resource: ReturnType<typeof createReadResourceTool>;
    read_prompt: ReturnType<typeof createReadPromptTool>;
    generate_image: ReturnType<typeof createGenerateImageTool>;
    web_search: ReturnType<typeof createWebSearchTool>;
    take_screenshot: ReturnType<typeof createTakeScreenshotTool>;
    scrape_url: ReturnType<typeof createScrapeUrlTool>;
    inspect_page: ReturnType<typeof createInspectPageTool>;
  };
}

/**
 * Wrap each tool's execute() with a posthog tool_called capture so built-in
 * tool usage shows up in the same analytics pipeline as passthrough MCP
 * tools. Preserves the original tool shape so AI SDK can't tell the wrapper
 * is there.
 */
export function instrumentBuiltIns<T extends Record<string, unknown>>(
  tools: T,
  params: BuiltinToolParams,
  ctx: StudioContext,
): T {
  const orgId = params.organization.id;
  const userId = ctx.auth?.user?.id;
  const result: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const t = tool as { execute?: Function; [k: string]: unknown };
    const originalExecute = t.execute;
    if (typeof originalExecute !== "function") {
      result[name] = tool;
      continue;
    }
    const hints = BUILTIN_TOOL_ANNOTATIONS[name];
    const isAsyncGen =
      originalExecute.constructor?.name === "AsyncGeneratorFunction";
    const captureToolCalled = (latencyMs: number, isError: boolean) => {
      if (!orgId || !userId) return;
      posthog.capture({
        distinctId: userId,
        event: "tool_called",
        groups: { organization: orgId },
        properties: {
          organization_id: orgId,
          tool_source: "builtin",
          tool_name: name,
          tool_safe_name: name,
          read_only: hints?.readOnly ?? null,
          destructive: hints?.destructive ?? null,
          idempotent: null,
          open_world: null,
          latency_ms: Math.round(latencyMs),
          is_error: isError,
        },
      });
    };
    // Generator-shaped execute must stay generator-shaped, otherwise the
    // AI SDK's isAsyncIterable check fails on the returned Promise and the
    // streamed yields are dropped (subtask "No output available" bug).
    const wrappedExecute = isAsyncGen
      ? async function* (input: unknown, options: unknown) {
          const startTime = performance.now();
          let isError = false;
          try {
            yield* originalExecute.call(
              t,
              input,
              options,
            ) as AsyncIterable<unknown>;
          } catch (err) {
            isError = true;
            throw err;
          } finally {
            captureToolCalled(performance.now() - startTime, isError);
          }
        }
      : async (input: unknown, options: unknown) => {
          const startTime = performance.now();
          let isError = false;
          try {
            return await originalExecute.call(t, input, options);
          } catch (err) {
            isError = true;
            throw err;
          } finally {
            captureToolCalled(performance.now() - startTime, isError);
          }
        };
    result[name] = { ...t, execute: wrappedExecute };
  }
  return result as T;
}

/**
 * Get built-in tools as a ToolSet.
 * propose_plan is only included when chat mode is `plan`.
 */
export async function getBuiltInTools(
  writer: UIMessageStreamWriter,
  params: BuiltinToolParams,
  ctx: StudioContext,
) {
  const raw = await buildAllTools(writer, params, ctx);
  const tools = instrumentBuiltIns(raw, params, ctx) as typeof raw;

  if (!params.isPlanMode) {
    const { propose_plan: _, ...rest } = tools;
    return rest;
  }

  return tools;
}

/**
 * Lightweight built-in tool assembler for the shared agent-loop path.
 *
 * Returns the five core built-ins (subtask, user_ask, todo_write,
 * read_tool_output, propose_plan) as a synchronous ToolSet. Unlike
 * `getBuiltInTools`, this does NOT include VM/sandbox/web_search/
 * screenshot/browser tools — those depend on heavy infrastructure
 * (vmContext, pendingImages, htmlPageBuffer) that the subagent path
 * doesn't carry. The caller is responsible for filtering out any of
 * these tools that don't apply for the current agent kind.
 */
export interface BuildBuiltInToolsOptions {
  ctx: StudioContext;
  writer: UIMessageStreamWriter;
  toolOutputMap: Map<string, string>;
  subtaskParams: import("./subtask").SubtaskParams;
  planMode: boolean;
}

export function buildBuiltInTools(
  opts: BuildBuiltInToolsOptions,
): Record<string, unknown> {
  const {
    ctx,
    writer,
    toolOutputMap,
    subtaskParams,
    planMode: _planMode,
  } = opts;
  const tools: Record<string, unknown> = {
    user_ask: userAskTool,
    todo_write: todoWriteTool,
    propose_plan: proposePlanTool,
    read_tool_output: createReadToolOutputTool({ toolOutputMap }),
  };
  // subtask requires a provider — skip when provider is null.
  if (subtaskParams.provider) {
    tools.subtask = createSubtaskTool(writer, subtaskParams, ctx);
  }
  return tools;
}
