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
import { computeCost } from "../pricing";
import { createLanguageModel } from "../stream-core";
import { buildSystemMessages } from "../system-prompt";

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
      const { tools: mcpTools } = await toolsFromMCP(
        mcpClient,
        new Map(),
        writer,
        "auto",
        { disableOutputTruncation: true },
      );
      // Sort tools alphabetically for byte-stable serialization across
      // calls — required for Anthropic tool-cache to actually hit. Mark
      // the LAST tool with anthropic.cacheControl so all tool definitions
      // become a cached prefix (the Anthropic tool layer is separate from
      // the system/messages layer, so this doesn't consume a system BP).
      const sortedTools = Object.entries(mcpTools)
        .filter(([name]) => !SUBAGENT_EXCLUDED_TOOLS.includes(name))
        .sort(([a], [b]) => a.localeCompare(b));
      const lastToolIdx = sortedTools.length - 1;
      const subagentTools = Object.fromEntries(
        sortedTools.map(([name, t], i) => [
          name,
          i === lastToolIdx
            ? {
                ...t,
                providerOptions: {
                  ...((t as { providerOptions?: Record<string, unknown> })
                    .providerOptions ?? {}),
                  anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } },
                },
              }
            : t,
        ]),
      );

      // ── 4. Build subagent system prompt ────────────────────────────
      const serverInstructions = mcpClient.getInstructions();
      const systemPrompts = buildSubagentSystemPrompt(serverInstructions);
      const systemPromptMessages = buildSystemMessages(
        systemPrompts,
        new Date(),
      );

      console.log(
        "[decopilot:cache subtask] === start org=%s vmcp=%s tools=%d ===\n[decopilot:cache subtask] system_prompt_order=%j",
        organization.id,
        agent_id,
        sortedTools.length,
        systemPromptMessages.map((m, i) => ({
          i,
          len: m.content.length,
          cached: Boolean(m.providerOptions?.anthropic?.cacheControl),
        })),
      );

      // ── 5. Run streamText as subagent ──────────────────────────────
      let accumulatedUsage: UsageStats = emptyUsageStats();
      let subAccumulatedCacheRead = 0;
      let subAccumulatedCacheWrite = 0;
      let subAccumulatedInput = 0;
      let subAccumulatedOutput = 0;
      let subAccumulatedCost = 0;
      let subAccumulatedUncached = 0;
      let subPricingUnknown = false;

      const result = streamText({
        model: createLanguageModel(provider, models.thinking),
        system: systemPromptMessages,
        prompt,
        tools: subagentTools,
        providerOptions: {
          openrouter: {
            cache_control: { type: "ephemeral", ttl: "5m" },
          },
        },
        abortSignal,
        stopWhen: stepCountIs(SUBAGENT_STEP_LIMIT),
        maxOutputTokens:
          models.thinking.limits?.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
        onStepFinish: ({ usage, providerMetadata }) => {
          accumulatedUsage = addUsage(accumulatedUsage, {
            ...usage,
            providerMetadata,
          });
          const details = (
            usage as {
              inputTokenDetails?: {
                cacheReadTokens?: number;
                cacheWriteTokens?: number;
              };
            }
          ).inputTokenDetails;
          const cacheRead = details?.cacheReadTokens ?? 0;
          const cacheWrite = details?.cacheWriteTokens ?? 0;
          subAccumulatedCacheRead += cacheRead;
          subAccumulatedCacheWrite += cacheWrite;
          subAccumulatedInput += usage.inputTokens ?? 0;
          subAccumulatedOutput += usage.outputTokens ?? 0;
          const cost = computeCost(
            models.thinking.provider ?? undefined,
            models.thinking.id,
            {
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
              cacheReadTokens: cacheRead,
              cacheWriteTokens: cacheWrite,
            },
          );
          if (cost) {
            subAccumulatedCost += cost.total;
            subAccumulatedUncached += cost.uncachedEquivalent;
          } else {
            subPricingUnknown = true;
          }
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

      // ── 7. Cache observability ─────────────────────────────────────
      const subStatus =
        subAccumulatedCacheRead > 0
          ? "HIT ✅"
          : subAccumulatedCacheWrite > 0
            ? "WRITE 📝"
            : "MISS ❌";
      const subDenom = subAccumulatedInput;
      const subHitRatio = subDenom > 0 ? subAccumulatedCacheRead / subDenom : 0;
      const subPct = (subHitRatio * 100).toFixed(1);
      const subCost = subPricingUnknown
        ? "(model unpriced)"
        : `$${subAccumulatedCost.toFixed(6)}`;
      const subUncached = subPricingUnknown
        ? "(n/a)"
        : `$${subAccumulatedUncached.toFixed(6)}`;
      const subSavedAbs = subPricingUnknown
        ? 0
        : subAccumulatedUncached - subAccumulatedCost;
      const subSavedPct =
        !subPricingUnknown && subAccumulatedUncached > 0
          ? `${((subSavedAbs / subAccumulatedUncached) * 100).toFixed(1)}%`
          : "0.0%";
      const subSaved = subPricingUnknown
        ? "(n/a)"
        : `$${subSavedAbs.toFixed(6)} (${subSavedPct})`;
      console.log(
        [
          "",
          "╔════════════════════════════════════════════════════════════════════╗",
          `║  [decopilot:cache subtask] ${subStatus.padEnd(39)}║`,
          "╠════════════════════════════════════════════════════════════════════╣",
          `║  org      : ${organization.id.padEnd(54)}║`,
          `║  vmcp     : ${agent_id.padEnd(54)}║`,
          `║  tools    : ${String(sortedTools.length).padEnd(54)}║`,
          "╠────────────────────────────────────────────────────────────────────╣",
          `║  provider : ${(models.thinking.provider ?? "unknown").padEnd(54)}║`,
          `║  model    : ${models.thinking.id.padEnd(54)}║`,
          `║  input    : ${String(subAccumulatedInput).padEnd(54)}║`,
          `║  output   : ${String(subAccumulatedOutput).padEnd(54)}║`,
          `║  cache rd : ${String(subAccumulatedCacheRead).padEnd(54)}║`,
          `║  cache wr : ${String(subAccumulatedCacheWrite).padEnd(54)}║`,
          `║  hit_ratio: ${`${subPct}%`.padEnd(54)}║`,
          "╠────────────────────────────────────────────────────────────────────╣",
          `║  cost     : ${subCost.padEnd(54)}║`,
          `║  if uncached: ${subUncached.padEnd(52)}║`,
          `║  saved    : ${subSaved.padEnd(54)}║`,
          `║  latencyMs: ${String(Math.round(latencyMs)).padEnd(54)}║`,
          "╚════════════════════════════════════════════════════════════════════╝",
          `[decopilot:cache subtask] === end org=${organization.id} vmcp=${agent_id} ===`,
          "",
        ].join("\n"),
      );
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
