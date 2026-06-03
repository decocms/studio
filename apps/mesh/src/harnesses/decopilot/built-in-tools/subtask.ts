/**
 * subtask Built-in Tool — thin wrapper around runAgentLoop.
 *
 * The actual model invocation, tool assembly, system-prompt
 * assembly, and error handling all live in runAgentLoop. This file
 * owns only subtask-specific concerns: validating the target
 * agent, creating an MCP client for it, draining the subagent's
 * stream to completion, emitting the subtask-metadata data chunk,
 * and yielding a single structured result for toModelOutput.
 */

import type { StudioContext, OrganizationScope } from "@/core/studio-context";
import { createVirtualClientFrom } from "@/mcp-clients/virtual-mcp";
import type { UIMessageStreamWriter } from "ai";
import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { MeshProvider } from "@/ai-providers/types";
import type { ModelsConfig } from "../../../api/routes/decopilot/types";
import { runAgentLoop } from "../run-agent-loop";
import { SUBAGENT_STEP_LIMIT } from "../../../api/routes/decopilot/constants";

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

export function createSubtaskTool(
  writer: UIMessageStreamWriter,
  params: SubtaskParams,
  ctx: StudioContext,
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

      // 1. Validate the target agent.
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

      // 2. Create MCP client for the target.
      const mcpClient = await createVirtualClientFrom(
        virtualMcp,
        ctx,
        "passthrough",
      );

      try {
        // 3. Call runAgentLoop with subagent kind.
        const handle = await runAgentLoop({
          kind: "subagent",
          ctx,
          organization,
          virtualMcp: {
            id: virtualMcp.id,
            instructions: mcpClient.getInstructions(),
            repo: virtualMcp.metadata?.githubRepo ?? undefined,
          },
          mcpClient,
          provider,
          models,
          messages: [{ role: "user", content: prompt }],
          abortSignal: abortSignal ?? new AbortController().signal,
          stepLimit: SUBAGENT_STEP_LIMIT,
          toolApprovalLevel: "auto",
          planMode: false,
          writer,
          subtaskParams: { provider, organization, models, needsApproval },
          // Subagent inherits the parent's writer for nested chunk routing.
          // Subagent gets prompts/connections blocks via the MCP client
          // (which is both the tool source AND the prompts source for the
          // target agent). This passes through to buildAgentSystemPrompt.
          passthroughClient: mcpClient,
        });

        // 4. Drain the UI stream so streamText runs to completion.
        //    We intentionally don't yield each progressive UIMessage:
        //      - AI SDK's executeTool helper reads only YIELDED values
        //        (the generator's return value is discarded), so the
        //        last yielded UIMessage would be what reaches
        //        toModelOutput — losing our extracted text/error.
        //      - Each progressive UIMessage from readUIMessageStream
        //        carries the full accumulated state (incl. multi-MB
        //        MCP tool outputs), causing per-chunk NATS payloads
        //        to exceed the 1 MB default and be dropped silently.
        //    Instead, we drain here and yield a single structured
        //    object at the end (step 7).
        const reader = handle.result.toUIMessageStream().getReader();
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } finally {
          reader.releaseLock();
        }

        // 5. Collect results from the resolved promises.
        const error = await handle.error;
        const finishReason = await handle.result.finishReason;
        const steps = await handle.result.steps;
        const aggregatedText = steps
          .map((s) => s.text ?? "")
          .filter((t) => t.trim().length > 0)
          .join("\n\n")
          .trim();
        const usage = await handle.result.usage;

        console.log(
          `[subtask:${agent_id}] completed: finishReason=${finishReason}, steps=${steps.length}, textLength=${aggregatedText.length}, error=${error ? "yes" : "no"}, usage=${JSON.stringify({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens })}`,
        );

        // 6. Emit metadata chunks to the parent's writer.
        const latencyMs = performance.now() - startTime;
        writer.write({
          type: "data-tool-metadata",
          id: toolCallId,
          data: { annotations: SUBTASK_ANNOTATIONS, latencyMs },
        });
        writer.write({
          type: "data-tool-subtask-metadata",
          id: toolCallId,
          data: { usage, agent: agent_id, models },
        });

        // 7. Yield the structured result as the ONLY (and therefore
        //    final) value. The AI SDK's executeTool helper uses the
        //    LAST YIELDED value as `output` for toModelOutput — the
        //    generator's return value is discarded. Yielding here
        //    keeps the parent's UI payload tiny and the model output
        //    correct.
        yield { text: aggregatedText, error, finishReason };
      } finally {
        mcpClient.close().catch(() => {});
      }
    },
    toModelOutput: ({ output }) => {
      const o = output as
        | { text?: string; error?: string; finishReason?: string }
        | undefined;
      if (o?.error) {
        return {
          type: "error-text" as const,
          value: `Subtask failed: ${o.error}`,
        };
      }
      const text = o?.text?.trim();
      const stepLimitHit = o?.finishReason === "length";

      if (text) {
        const prefix = stepLimitHit
          ? "[Subtask hit step limit — partial result below; consider narrowing the task.]\n\n"
          : "";
        return { type: "text" as const, value: prefix + text };
      }
      if (stepLimitHit) {
        return {
          type: "text" as const,
          value:
            "[Subtask hit step limit before producing a final report. The subagent did work but ran out of steps. Narrow the task or increase the budget.]",
        };
      }
      return {
        type: "text" as const,
        value: "Subtask completed (no output).",
      };
    },
  });
}
