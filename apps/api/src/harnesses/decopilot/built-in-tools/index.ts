/**
 * Decopilot Built-in Tools
 *
 * Client-side and server-side tools for decopilot agent interactions.
 * These use AI SDK tool() function and are registered directly in the decopilot API.
 */

import type { StudioContext, OrganizationScope } from "@/core/studio-context";
import { posthog } from "@/posthog";
import type { ToolSet, UIMessageStreamWriter } from "ai";
import {
  toolNeedsApproval,
  type ToolApprovalLevel,
} from "@/harnesses/lib/decopilot/mcp-tools";

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
  deep_research: { readOnly: true, destructive: false },
  generate_image: { readOnly: false, destructive: false },
  open_in_agent: { readOnly: false, destructive: false },
  subtask: { readOnly: false, destructive: false },
  user_ask: { readOnly: true, destructive: false },
  propose_plan: { readOnly: true, destructive: false },
  enable_tool: { readOnly: true, destructive: false },
  todo_write: { readOnly: false, destructive: false },
  update_interests: { readOnly: false, destructive: false },
  load_repo: { readOnly: false, destructive: true },
  search_threads: { readOnly: true, destructive: false },
  get_thread: { readOnly: true, destructive: false },
  list_thread_messages: { readOnly: true, destructive: false },
};
import { createReadToolOutputTool } from "@/harnesses/lib/decopilot/built-in-tools/read-tool-output";
import { type VirtualClient } from "@/harnesses/lib/decopilot/built-in-tools/sandbox";
import { createVmTools } from "@/harnesses/lib/decopilot/built-in-tools/vm-tools/index";
import type { HtmlArtifactBuffer } from "@/harnesses/lib/decopilot/built-in-tools/vm-tools/types";
import { buildClusterSandboxFs } from "./cluster-sandbox-fs";
import { createSwappableFs } from "./swappable-fs";
import { createLoadRepoTool } from "./load-repo";
import { createSubtaskTool, SubtaskInputSchema } from "./subtask";
import { userAskTool } from "@/harnesses/lib/decopilot/built-in-tools/user-ask";
import { todoWriteTool } from "@/harnesses/lib/decopilot/built-in-tools/todo-write";
import { createUpdateInterestsTool } from "@/harnesses/lib/decopilot/built-in-tools/update-interests";
import { proposePlanTool } from "@/harnesses/lib/decopilot/built-in-tools/propose-plan";
import { createGenerateImageTool } from "./generate-image";
import { makeBackgroundable } from "@/harnesses/lib/decopilot/built-in-tools/backgroundable";
import { registerFlip } from "@/harnesses/decopilot/flip-registry";
import type { BackgroundDispatcher } from "@/harnesses/lib/decopilot/built-in-tools/backgroundable";
import { GenerateImageInputSchema } from "@/harnesses/lib/decopilot/built-in-tools/portable-media-tools";
import { createWebSearchTool } from "@/harnesses/lib/decopilot/built-in-tools/web-search";
import { createClusterResearchJob } from "./cluster-research-job";
import {
  createTakeScreenshotTool,
  type PendingImage,
} from "@/harnesses/lib/decopilot/built-in-tools/take-screenshot";
import { createScrapeUrlTool } from "@/harnesses/lib/decopilot/built-in-tools/scrape-url";
import { createInspectPageTool } from "@/harnesses/lib/decopilot/built-in-tools/inspect-page";
import { buildPortableBuiltInTools } from "@/harnesses/lib/decopilot/built-in-tools/portable-built-ins";
import { createThreadTools } from "./thread-tools";
import { BROWSERLESS_BASE_URL } from "@/harnesses/lib/decopilot/built-in-tools/constants";
import type { ModelsConfig } from "@/harnesses/lib/types";
import type { StudioProvider } from "@/ai-providers/types";
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
  /**
   * When true, the sandbox fs layer mints a virtual-MCP endpoint and fires
   * POST /_sandbox/tools/sync after provisioning so the daemon materializes
   * the tool catalog + endpoint file under `<repo>/.deco/tools/`.
   */
  syncTools?: boolean;
};

export interface BuiltinToolParams {
  /** Provider — the subtask tool is omitted when no provider is available. */
  provider: StudioProvider | null;
  /** Provider used to instantiate `generate_image`. Caller passes the
   *  chat provider when the org's `image` tier shares the chat credential
   *  (or no tier is configured) — otherwise a separately-activated
   *  provider matching the image-tier credential. */
  imageProvider: StudioProvider | null;
  /** Provider used to instantiate the quick `web_search` tool. Same aliasing
   *  rule as `imageProvider` — defaults to the chat provider when the org's
   *  `web_search` tier shares the chat credential. */
  webSearchProvider: StudioProvider | null;
  /** Provider used to instantiate `deep_research`'s async/deep path.
   *  Same aliasing rule as `imageProvider`. Decoupling from the chat
   *  provider lets deep_research keep using a Gemini deep-research model
   *  even when the chat is routed via LiteLLM/OpenRouter. */
  deepResearchProvider: StudioProvider | null;
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
  /** Per-turn HTML-artifact fast-path mirror (see `HtmlArtifactBuffer`). */
  htmlArtifactBuffer?: HtmlArtifactBuffer;
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
  /**
   * When present, slow built-ins flagged backgroundable (today: generate_image)
   * enqueue a durable background job and return immediately instead of holding
   * the turn open. Absent on desktop/tests → those tools run inline.
   */
  backgroundDispatcher?: BackgroundDispatcher | null;
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
    webSearchProvider,
    deepResearchProvider,
    organization,
    models,
    toolApprovalLevel = "auto",
    isPlanMode = false,
    toolOutputMap,
    pendingImages,
    passthroughClient,
    vmContext,
    htmlArtifactBuffer,
    taskId,
    agentId,
    onChildUsage,
    backgroundDispatcher,
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
  // Thread search built-ins — always available so the Super Agent can recall
  // past org conversations regardless of the passthrough MCP allowlist.
  Object.assign(tools, createThreadTools(ctx));
  // VM file tools — six LLM-visible tools (read/write/edit/grep/glob/bash)
  // always registered when a vmContext is provided. The handle is resolved
  // lazily on the first tool invocation: `ensureSandbox` either reuses
  // the existing sandboxMap entry (fast path) or provisions a new sandbox via
  // the env-selected runner. The promise is memoized on the closure so
  // parallel first calls (e.g. the model emitting bash + read in one step)
  // share a single provisioning round-trip.
  const vmNeedsApproval =
    toolNeedsApproval(toolApprovalLevel, false, approvalOpts) !== false;
  // Captured so a self-clone subtask can inherit the SAME sandbox tools (and
  // therefore the same sandbox), letting it run bash / read-write files.
  let vmTools: ToolSet | undefined;
  if (vmContext) {
    // The flat fs hooks (provider resolution + lazy handle + auto-restart retry
    // layer) are built by the cluster glue so the portable tools never import
    // `@decocms/sandbox` (spec §4.3). Provisioning stays lazy inside the hooks —
    // `ensureSandbox` runs on the first VM-tool call, not here.
    const initialFs = await buildClusterSandboxFs(ctx, {
      virtualMcpId: vmContext.virtualMcpId,
      branch: vmContext.branch,
      userId: vmContext.userId,
      syncTools: vmContext.syncTools,
    });
    // The VM tools are built once and close over the fs. `load_repo` switches
    // the thread's repo mid-run onto a new sandbox branch — so the tools call
    // through a swappable forwarder that `load_repo` re-points after the clone
    // lands, making the repo usable THIS turn instead of only the next message.
    const swappableFs = createSwappableFs(initialFs);
    vmTools = createVmTools({
      fs: swappableFs.fs,
      htmlArtifactBuffer,
      toolOutputMap,
      needsApproval: vmNeedsApproval,
      pendingImages,
      ctx,
      threadId: vmContext.threadId,
      virtualMcpId: vmContext.virtualMcpId,
    }) as ToolSet;
    Object.assign(tools, vmTools);
    // Repo switcher — dynamic description lists the org's imported repos; calling
    // it binds the repo to the thread, eagerly clones its sandbox, and opens the
    // Preview. Returns null (tool omitted) for any agent but the super-agent, and
    // when the org has no imported repos (nothing to switch).
    const loadRepo = await createLoadRepoTool({
      ctx,
      orgId: organization.id,
      virtualMcpId: vmContext.virtualMcpId,
      userId: vmContext.userId,
      threadId: vmContext.threadId,
      writer,
      // Re-point the live fs tools at the newly-cloned repo sandbox. Built with
      // the same syncTools flag so the switched-in sandbox also materializes the
      // tool catalog. Provisioning stays lazy — the next VM-tool call ensures it.
      rebindFs: async (branch) => {
        swappableFs.swap(
          await buildClusterSandboxFs(ctx, {
            virtualMcpId: vmContext.virtualMcpId,
            branch,
            userId: vmContext.userId,
            syncTools: vmContext.syncTools,
          }),
        );
      },
    });
    if (loadRepo) tools.load_repo = loadRepo;
  }
  // Subtask requires a provider for its LLM calls.
  if (provider) {
    // Made backgroundable: the model can opt a subtask into a durable cluster
    // run (`background: true`) instead of blocking the turn. Without a
    // dispatcher (none wired) it runs inline.
    tools.subtask = makeBackgroundable(
      "subtask",
      SubtaskInputSchema,
      createSubtaskTool(
        writer,
        {
          provider,
          organization,
          models,
          // Pass the caller's own agent id so the model can clone itself by
          // omitting agent_id (heavy discovery → fresh, isolated context).
          self: { id: agentId },
          // The current thread id (taskId) — lets a subagent-opened PR advance
          // the linked task board card via the thread link (In Review).
          currentThreadId: taskId,
          needsApproval:
            toolNeedsApproval(toolApprovalLevel, false, approvalOpts) !== false,
          // Roll the child run's usage into the parent's accumulator (Task 17).
          onChildUsage,
          // Self-clones inherit the parent's sandbox tools so they can run
          // bash / file I/O against the SAME sandbox.
          vmTools,
          // Full parent built-in params so a delegated subagent is built with
          // the SAME heavy tools (vm/generate_image/web_search), not the light
          // core. The subagent's own client/sandbox are substituted downstream.
          parentBuiltInParams: params,
        },
        ctx,
      ),
      backgroundDispatcher,
      // Let the user flip a still-running foreground subtask to the background
      // (frees the thread gate so they can keep chatting). Inert without a
      // dispatcher — makeBackgroundable returns the inner tool unchanged there.
      (toolCallId) => registerFlip(taskId, toolCallId),
    ) as ReturnType<typeof createSubtaskTool>;
  }
  // generate_image requires a provider and an image model selection.
  // The provider is picked from `imageProvider` so the org can pair the
  // image tier with a different credential than the chat tier (caller
  // aliases it to `provider` when they share a credential).
  if (imageProvider && models.image && ctx.objectStorage) {
    // Cluster builds the `objectStorage` + `allowHttpExternalUrls` hooks from
    // StudioContext + settings; the tool itself no longer reads either
    // (HarnessDeps conversion).
    // generate_image is slow (tens of seconds). When a background dispatcher
    // is wired (cluster, hosted runs) it's made backgroundable: the call
    // enqueues a durable job and returns immediately so the turn finishes and
    // the thread keeps accepting messages; the job delivers the image + a
    // reaction turn later. Without a dispatcher it runs inline (today's
    // behavior).
    tools.generate_image = makeBackgroundable(
      "generate_image",
      GenerateImageInputSchema,
      createGenerateImageTool(writer, {
        provider: imageProvider,
        imageModelInfo: models.image,
        objectStorage: ctx.objectStorage,
        allowHttpExternalUrls: getSettings().localMode,
      }),
      backgroundDispatcher,
    ) as ReturnType<typeof createGenerateImageTool>;
  }
  // web_search (quick) and deep_research (deep) both consume the cluster-built
  // `researchJob` async-gen hook (HarnessDeps conversion, spec §6). The
  // provider/DB lifecycle lives in `createClusterResearchJob`; the tools only
  // drive the generator. Each tier resolves its own provider so it can use a
  // different model/credential than the chat model (e.g. Gemini deep research
  // via Google while chat is on LiteLLM). Hook presence is the gate — desktop
  // omits the providers and these tools simply aren't in the set (§5.1).
  //
  // web_search forces the streaming path (mode "quick") as a backstop: even if
  // a deep/async model slips into the web_search tier, a quick lookup never
  // launches an async research job. The primary guard against slow models in
  // this slot is the capability-aware UI filter (`isQuickSearchModel`).
  if (webSearchProvider && models.webSearch) {
    const researchJob = createClusterResearchJob({
      provider: webSearchProvider,
      modelInfo: models.webSearch,
      ctx,
      mode: "quick",
      toolName: "web_search",
    });
    tools.web_search = createWebSearchTool(writer, {
      researchJob,
      toolOutputMap,
      taskId,
    });
  }
  // deep_research auto-selects the async deep-research path when the provider
  // supports it (Gemini Deep Research), else streams (Perplexity deep-research).
  if (deepResearchProvider && models.deepResearch) {
    const researchJob = createClusterResearchJob({
      provider: deepResearchProvider,
      modelInfo: models.deepResearch,
      ctx,
      mode: "deep",
      toolName: "deep_research",
    });
    tools.deep_research = createWebSearchTool(writer, {
      researchJob,
      toolOutputMap,
      taskId,
      description:
        "Run in-depth, multi-source research and synthesize a comprehensive, " +
        "cited report. Use this when the user needs thorough analysis, a " +
        "literature/market review, or a question that warrants exploring many " +
        "sources — accuracy and depth matter more than latency. For quick " +
        "lookups or fact-checks, use `web_search` instead.",
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
    generate_image: ReturnType<typeof createGenerateImageTool>;
    web_search: ReturnType<typeof createWebSearchTool>;
    deep_research: ReturnType<typeof createWebSearchTool>;
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
 * (vmContext, pendingImages) that the subagent path
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
  const { ctx, writer, toolOutputMap, subtaskParams, planMode } = opts;
  const tools: Record<string, unknown> = {
    user_ask: userAskTool,
    todo_write: todoWriteTool,
    read_tool_output: createReadToolOutputTool({ toolOutputMap }),
  };
  // Mirrors getBuiltInTools' plan-mode gate: propose_plan's UX ("approve →
  // new thread seeded with this plan") only makes sense in Plan Mode —
  // outside it the model must not be able to trigger that flow.
  if (planMode) {
    tools.propose_plan = proposePlanTool;
  }
  // subtask requires a provider — skip when provider is null.
  if (subtaskParams.provider) {
    tools.subtask = createSubtaskTool(writer, subtaskParams, ctx);
  }
  return tools;
}
