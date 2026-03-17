/**
 * Decopilot Built-in Tools
 *
 * Client-side and server-side tools for decopilot agent interactions.
 * These use AI SDK tool() function and are registered directly in the decopilot API.
 */

import type { MeshContext, OrganizationScope } from "@/core/mesh-context";
import type { UIMessageStreamWriter } from "ai";
import { toolNeedsApproval, type ToolApprovalLevel } from "../helpers";
import { createAgentSearchTool } from "./agent-search";
import { createReadToolOutputTool } from "./read-tool-output";
import { createReadPromptTool } from "./prompts";
import { createListResourcesTool, createReadResourceTool } from "./resources";
import { createSandboxTool, type VirtualClient } from "./sandbox";
import { createSubtaskTool } from "./subtask";
import { userAskTool } from "./user-ask";
import type { ModelsConfig } from "../types";
import { MeshProvider } from "@/ai-providers/types";

export interface BuiltinToolParams {
  provider: MeshProvider;
  organization: OrganizationScope;
  models: ModelsConfig;
  toolApprovalLevel?: ToolApprovalLevel;
  toolOutputMap: Map<string, string>;
  passthroughClient: VirtualClient;
}

/**
 * Get all built-in tools as a ToolSet.
 * Deps required so ChatMessage type (via ReturnType<typeof getBuiltInTools>)
 * always includes subtask in the parts union.
 */
export function getBuiltInTools(
  writer: UIMessageStreamWriter,
  params: BuiltinToolParams,
  ctx: MeshContext,
) {
  const {
    provider,
    organization,
    models,
    toolApprovalLevel = "none",
    toolOutputMap,
    passthroughClient,
  } = params;
  return {
    user_ask: userAskTool,
    subtask: createSubtaskTool(
      writer,
      {
        provider,
        organization,
        models,
        needsApproval: toolNeedsApproval(toolApprovalLevel, false),
      },
      ctx,
    ),
    agent_search: createAgentSearchTool(
      writer,
      {
        organization,
        needsApproval: toolNeedsApproval(toolApprovalLevel, true),
      },
      ctx,
    ),
    read_tool_output: createReadToolOutputTool({
      toolOutputMap,
    }),
    sandbox: createSandboxTool({
      passthroughClient,
      toolOutputMap,
      needsApproval: toolNeedsApproval(toolApprovalLevel, false),
    }),
    list_resources: createListResourcesTool({
      passthroughClient,
      toolOutputMap,
    }),
    read_resource: createReadResourceTool({
      passthroughClient,
      toolOutputMap,
    }),
    read_prompt: createReadPromptTool({
      passthroughClient,
      toolOutputMap,
    }),
  } as const;
}
