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
import type { ModelsConfig } from "../types";
import { MeshProvider } from "@/ai-providers/types";
import { createLanguageModel } from "../stream-core";

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
  "Usage notes:\n" +
  "- Every subtask call starts FRESH — no conversation history, no prior runs. Always include full context in the prompt; never use continuation phrases like 'continue' or 'as before'.\n" +
  "- Clearly tell the subagent whether you expect it to take action or just research.\n" +
  "- To parallelize work, launch multiple subtask calls in the same message.\n" +
  "- The subagent's output should generally be trusted.";

export interface SubtaskParams {
  provider: MeshProvider;
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

const SUBTASK_BASE_PROMPT = `You are a focused subtask agent delegated a specific task by a parent agent. You are NOT the parent agent.

## Rules (non-negotiable)

1. Do NOT converse, ask questions, or suggest next steps to the user — you cannot interact with them.
2. Do NOT delegate to other agents — execute directly.
3. Stay strictly within your task's scope. If you discover related work outside your scope, mention it in one sentence at most.

## Before Acting: Assess the Task

Before making ANY tool calls, evaluate: do you understand what to do, how to do it, and when you're done?

- **If unclear** → Respond IMMEDIATELY with what's missing. Make zero tool calls. The parent agent will reformulate with more context.
- **If clear** → Proceed autonomously. Be efficient, be thorough, don't second-guess. If you hit obstacles mid-execution, make reasonable judgment calls and note them.

## Execution

- Use your tools directly. Do not emit text between tool calls — use tools, then report once at the end.
- Keep your report under 500 words unless the task requires more detail. Be factual and concise.
- Do not use emojis.

## When Done: Report

End with a structured summary:
- **Result**: What you did, what you found or produced
- **Key files**: Relevant file paths (always absolute, never relative) — include only for research tasks
- **Issues**: Anything to flag — include only if there are issues

This report is all the parent agent sees.`;

export function buildSubagentSystemPrompt(
  agentInstructions?: string,
): string[] {
  const prompts = [SUBTASK_BASE_PROMPT];
  if (agentInstructions?.trim()) {
    prompts.push(agentInstructions);
  }
  return prompts;
}

export function createSubtaskTool(
  writer: UIMessageStreamWriter,
  params: SubtaskParams,
  ctx: MeshContext,
) {
  const { provider, organization, models, needsApproval } = params;

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
        "auto",
        { disableOutputTruncation: true },
      );
      const subagentTools = Object.fromEntries(
        Object.entries(mcpTools).filter(
          ([name]) => !SUBAGENT_EXCLUDED_TOOLS.includes(name),
        ),
      );

      // ── 4. Build subagent system prompt ────────────────────────────
      const serverInstructions = mcpClient.getInstructions();
      const systemPrompts = buildSubagentSystemPrompt(serverInstructions);

      // ── 5. Run streamText as subagent ──────────────────────────────
      let accumulatedUsage: UsageStats = emptyUsageStats();

      const result = streamText({
        model: createLanguageModel(provider, models.thinking),
        system: systemPrompts.map((content) => ({
          role: "system" as const,
          content,
        })),
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
        onAbort: () => {
          console.error(`[subtask:${agent_id}] Aborted`);
          mcpClient.close().catch(() => {});
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
