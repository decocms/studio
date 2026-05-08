/**
 * Decopilot Built-in Tools
 *
 * Client-side and server-side tools for decopilot agent interactions.
 * These use AI SDK tool() function and are registered directly in the decopilot API.
 */

import type { MeshContext, OrganizationScope } from "@/core/mesh-context";
import { posthog } from "@/posthog";
import type { UIMessageStreamWriter } from "ai";
import { toolNeedsApproval, type ToolApprovalLevel } from "../helpers";

// Known destructive/read-only classifications for built-in tools. Mirrors
// the MCP annotations used by passthrough tools so dashboards can filter
// uniformly across both sources.
const BUILTIN_TOOL_ANNOTATIONS: Record<
  string,
  { readOnly?: boolean; destructive?: boolean }
> = {
  agent_search: { readOnly: true, destructive: false },
  read_tool_output: { readOnly: true, destructive: false },
  read_resource: { readOnly: true, destructive: false },
  read_prompt: { readOnly: true, destructive: false },
  web_search: { readOnly: true, destructive: false },
  generate_image: { readOnly: false, destructive: false },
  open_in_agent: { readOnly: false, destructive: false },
  subtask: { readOnly: false, destructive: false },
  user_ask: { readOnly: true, destructive: false },
  propose_plan: { readOnly: true, destructive: false },
  enable_tools: { readOnly: true, destructive: false },
};
import { createAgentSearchTool } from "./agent-search";
import { createReadToolOutputTool } from "./read-tool-output";
import { createReadPromptTool } from "./prompts";
import { createReadResourceTool } from "./resources";
import { createSandboxTool, type VirtualClient } from "./sandbox";
import { createVmTools } from "./vm-tools";
import { getSharedRunner } from "@/sandbox/lifecycle";
import { ensureVmForBranch } from "@/tools/vm/start";
import { createSubtaskTool } from "./subtask";
import { userAskTool } from "./user-ask";
import { proposePlanTool } from "./propose-plan";
import { createGenerateImageTool } from "./generate-image";
import { createWebSearchTool } from "./web-search";
import { createTakeScreenshotTool, type PendingImage } from "./take-screenshot";
import { createScrapeUrlTool } from "./scrape-url";
import { createInspectPageTool } from "./inspect-page";
import type { ModelsConfig } from "../types";
import type { MeshProvider } from "@/ai-providers/types";

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
  organization: OrganizationScope;
  models: ModelsConfig;
  toolApprovalLevel?: ToolApprovalLevel;
  /** When true (chat mode `plan`), include `propose_plan` and plan-style approvals */
  isPlanMode?: boolean;
  toolOutputMap: Map<string, string>;
  passthroughClient: VirtualClient;
  /**
   * Images captured by take_screenshot, queued for injection as user
   * messages by prepareStep in stream-core.ts. This approach works
   * across all providers (including OpenRouter) since images in tool
   * result messages aren't universally supported.
   */
  pendingImages: PendingImage[];
  /**
   * When set, the six VM file tools (read/write/edit/grep/glob/bash) are
   * registered with a memoized lazy provisioner: the first tool call
   * triggers `ensureVmForBranch`, subsequent calls reuse the same handle.
   * When null, no VM-backed code execution tool is included.
   */
  vmContext?: VmContext | null;
  /** Thread (task) id of the current run — needed by tools that persist
   *  thread-scoped state (e.g. web_search reconnecting to Gemini Deep Research). */
  taskId: string;
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
  ctx: MeshContext,
) {
  const {
    provider,
    organization,
    models,
    toolApprovalLevel = "auto",
    isPlanMode = false,
    toolOutputMap,
    pendingImages,
    passthroughClient,
    vmContext,
    taskId,
  } = params;
  const approvalOpts = { isPlanMode };
  const tools: Record<string, unknown> = {
    user_ask: userAskTool,
    propose_plan: proposePlanTool,
    agent_search: createAgentSearchTool(
      writer,
      {
        organization,
        needsApproval:
          toolNeedsApproval(toolApprovalLevel, true, approvalOpts) !== false,
      },
      ctx,
    ),
    read_tool_output: createReadToolOutputTool({
      toolOutputMap,
    }),
    read_resource: createReadResourceTool({
      passthroughClient,
      toolOutputMap,
      ctx,
    }),
    read_prompt: createReadPromptTool({
      passthroughClient,
      toolOutputMap,
    }),
  };
  // VM file tools — six LLM-visible tools (read/write/edit/grep/glob/bash)
  // always registered when a vmContext is provided. The handle is resolved
  // lazily on the first tool invocation: `ensureVmForBranch` either reuses
  // the existing vmMap entry (fast path) or provisions a new sandbox via
  // the env-selected runner. The promise is memoized on the closure so
  // parallel first calls (e.g. the model emitting bash + read in one step)
  // share a single provisioning round-trip.
  const vmNeedsApproval =
    toolNeedsApproval(toolApprovalLevel, false, approvalOpts) !== false;
  if (vmContext) {
    const runner = await getSharedRunner(ctx);
    let cached: Promise<string> | null = null;
    const ensureHandle = () => {
      if (!cached) {
        cached = ensureVmForBranch(
          { virtualMcpId: vmContext.virtualMcpId, branch: vmContext.branch },
          ctx,
        ).then((entry) => entry.vmId);
        // Reset on failure so the next tool call retries instead of
        // permanently caching a rejected promise.
        cached.catch(() => {
          cached = null;
        });
      }
      return cached;
    };
    Object.assign(
      tools,
      createVmTools({
        runner,
        ensureHandle,
        toolOutputMap,
        needsApproval: vmNeedsApproval,
        pendingImages,
        ctx,
        threadId: vmContext.threadId,
        virtualMcpId: vmContext.virtualMcpId,
      }),
    );
  }
  // subtask requires a provider (LLM calls) — skip when provider is null (Claude Code)
  if (provider) {
    tools.subtask = createSubtaskTool(
      writer,
      {
        provider,
        organization,
        models,
        needsApproval:
          toolNeedsApproval(toolApprovalLevel, false, approvalOpts) !== false,
      },
      ctx,
    );
  }
  // generate_image requires a provider and an image model selection
  if (provider && models.image) {
    tools.generate_image = createGenerateImageTool(writer, {
      provider,
      imageModelInfo: models.image,
      ctx,
    });
  }
  // web_search requires a provider and a deep-research model
  if (provider && models.deepResearch) {
    tools.web_search = createWebSearchTool(writer, {
      provider,
      deepResearchModelInfo: models.deepResearch,
      ctx,
      toolOutputMap,
      taskId,
    });
  }
  // take_screenshot and scrape_url require Browserless API token
  if (process.env.BROWSERLESS_TOKEN) {
    tools.take_screenshot = createTakeScreenshotTool(writer, {
      ctx,
      toolOutputMap,
      pendingImages,
    });
    tools.scrape_url = createScrapeUrlTool(writer, {
      ctx,
      toolOutputMap,
    });
    tools.inspect_page = createInspectPageTool(writer, {
      ctx,
      toolOutputMap,
    });
  }
  return tools as {
    user_ask: typeof userAskTool;
    propose_plan: typeof proposePlanTool;
    subtask: ReturnType<typeof createSubtaskTool>;
    agent_search: ReturnType<typeof createAgentSearchTool>;
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
  ctx: MeshContext,
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
  ctx: MeshContext,
) {
  const raw = await buildAllTools(writer, params, ctx);
  const tools = instrumentBuiltIns(raw, params, ctx) as typeof raw;

  if (!params.isPlanMode) {
    const { propose_plan: _, ...rest } = tools;
    return rest;
  }

  return tools;
}
