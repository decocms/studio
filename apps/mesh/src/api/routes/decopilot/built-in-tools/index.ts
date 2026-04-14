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
import { createReadResourceTool } from "./resources";
import { createSandboxTool, type VirtualClient } from "./sandbox";
import { createOpenInAgentTool } from "./open-in-agent";
import { createSubtaskTool } from "./subtask";
import { userAskTool } from "./user-ask";
import { proposePlanTool } from "./propose-plan";
import { createGenerateImageTool } from "./generate-image";
import type { ModelsConfig } from "../types";
import type { MeshProvider } from "@/ai-providers/types";

export interface BuiltinToolParams {
  /** Provider — null for Claude Code (subtask tool is omitted when null) */
  provider: MeshProvider | null;
  organization: OrganizationScope;
  models: ModelsConfig;
  userId: string;
  toolApprovalLevel?: ToolApprovalLevel;
  toolOutputMap: Map<string, string>;
  passthroughClient: VirtualClient;
}

/**
 * Full tool set type — always includes propose_plan so that ChatMessage
 * (derived via ReturnType) can render historical plan parts regardless
 * of the current toolApprovalLevel.
 */
export type BuiltInToolSet = ReturnType<typeof buildAllTools>;

function buildAllTools(
  writer: UIMessageStreamWriter,
  params: BuiltinToolParams,
  ctx: MeshContext,
) {
  const {
    provider,
    organization,
    models,
    userId,
    toolApprovalLevel = "auto",
    toolOutputMap,
    passthroughClient,
  } = params;
  const tools: Record<string, unknown> = {
    user_ask: userAskTool,
    propose_plan: proposePlanTool,
    agent_search: createAgentSearchTool(
      writer,
      {
        organization,
        needsApproval: toolNeedsApproval(toolApprovalLevel, true) !== false,
      },
      ctx,
    ),
    read_tool_output: createReadToolOutputTool({
      toolOutputMap,
    }),
    sandbox: createSandboxTool({
      passthroughClient,
      toolOutputMap,
      needsApproval: toolNeedsApproval(toolApprovalLevel, false) !== false,
    }),
    read_resource: createReadResourceTool({
      passthroughClient,
      toolOutputMap,
    }),
    read_prompt: createReadPromptTool({
      passthroughClient,
      toolOutputMap,
    }),
    open_in_agent: createOpenInAgentTool(
      writer,
      {
        organization,
        userId,
        needsApproval: toolNeedsApproval(toolApprovalLevel, false) !== false,
      },
      ctx,
    ),
  };
  // subtask requires a provider (LLM calls) — skip when provider is null (Claude Code)
  if (provider) {
    tools.subtask = createSubtaskTool(
      writer,
      {
        provider,
        organization,
        models,
        needsApproval: toolNeedsApproval(toolApprovalLevel, false) !== false,
      },
      ctx,
    );
  }
  // generate_image requires a provider and an image model selection
  if (provider && models.image) {
    tools.generate_image = createGenerateImageTool({
      provider,
      imageModelInfo: models.image,
      writer,
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
    open_in_agent: ReturnType<typeof createOpenInAgentTool>;
    generate_image: ReturnType<typeof createGenerateImageTool>;
  };
}

/**
 * Get built-in tools as a ToolSet.
 * propose_plan is only included when toolApprovalLevel is "plan".
 */
export function getBuiltInTools(
  writer: UIMessageStreamWriter,
  params: BuiltinToolParams,
  ctx: MeshContext,
) {
  const tools = buildAllTools(writer, params, ctx);
  const { toolApprovalLevel = "auto" } = params;

  if (toolApprovalLevel !== "plan") {
    const { propose_plan: _, ...rest } = tools;
    return rest;
  }

  return tools;
}
