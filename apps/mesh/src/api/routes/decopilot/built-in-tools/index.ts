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
import { createSubtaskTool } from "./subtask";
import { userAskTool } from "./user-ask";
import type { ModelProvider, ModelsConfig } from "../types";
import { createReadToolOutputTool } from "./read-tool-output";

export interface BuiltinToolParams {
  modelProvider: ModelProvider;
  organization: OrganizationScope;
  models: ModelsConfig;
  toolApprovalLevel?: ToolApprovalLevel;
  toolOutputMap: Map<string, string>;
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
    modelProvider,
    organization,
    models,
    toolApprovalLevel = "none",
    toolOutputMap,
  } = params;
  return {
    user_ask: userAskTool,
    subtask: createSubtaskTool(
      writer,
      {
        modelProvider,
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
  } as const;
}
