/**
 * subtask Built-in Tool
 *
 * Server-side tool that spawns a streaming subagent to delegate work to another
 * agent (Virtual MCP). Uses AI SDK v6 streaming generator pattern.
 */

import type { MeshContext, OrganizationScope } from "@/core/mesh-context";
import { createVirtualClientFrom } from "@/mcp-clients/virtual-mcp";
import { addUsage, emptyUsageStats, type UsageStats } from "@decocms/mesh-sdk";
import type { UIMessageStreamWriter } from "ai";
import {
  readUIMessageStream,
  stepCountIs,
  streamText,
  tool,
  zodSchema,
} from "ai";
import { z } from "zod";
import {
  DEFAULT_MAX_TOKENS,
  SUBAGENT_EXCLUDED_TOOLS,
  SUBAGENT_STEP_LIMIT,
} from "../constants";
import { toolsFromMCP } from "../helpers";
import type { ModelProvider, ModelsConfig } from "../types";

export const SubtaskInputSchema = z.object({
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
    .describe(
      "The ID of the agent (Virtual MCP) to delegate to. " +
        "This agent must exist and be active in the current organization.",
    ),
});

export type SubtaskInput = z.infer<typeof SubtaskInputSchema>;

export interface SubtaskResultMeta {
  usage: UsageStats;
}

const SUBTASK_DESCRIPTION =
  "Delegate a self-contained task to another agent. The subagent runs independently with its own tools " +
  "and returns results when complete. Use this when a task is better handled by a specialized agent, " +
  "or to parallelize work across agents.\n\n" +
  "IMPORTANT: Every subtask call starts FRESH — no conversation history, no prior runs. Even if you call it multiple times, each run is isolated. Always include full context in the prompt; never use continuation phrases like 'continue' or 'as before'.";

export interface SubtaskParams {
  modelProvider: ModelProvider;
  organization: OrganizationScope;
  models: ModelsConfig;
  needsApproval?: boolean;
}

const SUBTASK_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export function buildSubagentSystemPrompt(agentInstructions?: string): string {
  let prompt = `You are a focused subtask agent delegated a specific task by a parent agent.

## Before Acting: Assess the Task

Before making ANY tool calls, evaluate: do you understand what to do, how to do it, and when you're done?

- **If unclear** → Respond IMMEDIATELY with what's missing and what questions would unblock you. Make zero tool calls. The parent agent will reformulate with more context.
- **If clear** → Proceed autonomously. Be efficient (minimal tool calls), be thorough, don't second-guess. If you hit obstacles mid-execution, make reasonable judgment calls and note them.

## When Done: Summarize

End with a concise summary: what you did, what you found/produced, any assumptions made. This is all the parent agent sees.

## Constraints

- You cannot interact with the user — return clarification needs as your response.
- You cannot delegate to other agents.
- Stay focused on the task.`;

  if (agentInstructions?.trim()) {
    prompt += `\n\n---\n\n## Agent-Specific Instructions\n\n${agentInstructions}`;
  }

  return prompt;
}

export function createSubtaskTool(
  writer: UIMessageStreamWriter,
  params: SubtaskParams,
  ctx: MeshContext,
) {
  const { modelProvider, organization, models, needsApproval } = params;

  return tool({
    description: SUBTASK_DESCRIPTION,
    inputSchema: zodSchema(SubtaskInputSchema),
    needsApproval,
    execute: async function* (
      { prompt, agent_id },
      { abortSignal, toolCallId },
    ) {
      const startTime = performance.now();

      // ── 1. Load and validate target agent ──────────────────────────
      const virtualMcp = await ctx.storage.virtualMcps.findById(
        agent_id,
        organization.id,
      );

      if (!virtualMcp || virtualMcp.organization_id !== organization.id) {
        throw new Error("Agent not found");
      }

      if (virtualMcp.status !== "active") {
        throw new Error("Agent is not active");
      }

      // ── 2. Create MCP client for the target agent ──────────────────
      const mcpClient = await createVirtualClientFrom(
        virtualMcp,
        ctx,
        "passthrough",
      );

      // ── 3. Load tools, excluding ones that shouldn't nest ──────────
      const mcpTools = await toolsFromMCP(
        mcpClient,
        new Map(),
        writer,
        "yolo",
        { disableOutputTruncation: true },
      );
      const subagentTools = Object.fromEntries(
        Object.entries(mcpTools).filter(
          ([name]) => !SUBAGENT_EXCLUDED_TOOLS.includes(name),
        ),
      );

      // ── 4. Build subagent system prompt ────────────────────────────
      const serverInstructions = mcpClient.getInstructions();
      const systemPrompt = buildSubagentSystemPrompt(serverInstructions);

      // ── 5. Run streamText as subagent ──────────────────────────────
      let accumulatedUsage: UsageStats = emptyUsageStats();

      const result = streamText({
        model: modelProvider.thinkingModel,
        system: systemPrompt,
        prompt,
        tools: subagentTools,
        abortSignal,
        stopWhen: stepCountIs(SUBAGENT_STEP_LIMIT),
        maxOutputTokens:
          models.thinking.limits?.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
        onStepFinish: ({ usage, providerMetadata }) => {
          accumulatedUsage = addUsage(accumulatedUsage, {
            ...usage,
            providerMetadata,
          });
        },
        onError: (error) => {
          console.error(`[subtask:${agent_id}] Error`, error);
        },
      });

      // ── 6. Stream results via readUIMessageStream ──────────────────
      for await (const message of readUIMessageStream({
        stream: result.toUIMessageStream(),
      })) {
        yield message;
      }

      // Emit tool metadata (annotations + latency) and subtask metadata
      const latencyMs = performance.now() - startTime;
      writer.write({
        type: "data-tool-metadata",
        id: toolCallId,
        data: { annotations: SUBTASK_ANNOTATIONS, latencyMs },
      });
      writer.write({
        type: "data-tool-subtask-metadata",
        id: toolCallId,
        data: {
          usage: accumulatedUsage,
          agent: agent_id,
          models,
        },
      });
    },
    toModelOutput: ({ output: message }) => {
      const lastTextPart = message?.parts?.findLast(
        (p) => "type" in p && p.type === "text" && "text" in p,
      );

      return {
        type: "text" as const,
        value: lastTextPart?.text ?? "Subtask completed (no output).",
      };
    },
  });
}
