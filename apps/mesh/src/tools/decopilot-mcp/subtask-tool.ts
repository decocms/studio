/**
 * Cluster-side MCP exposure of the `subtask` decopilot built-in.
 *
 * Desktop decopilot cannot safely run recursive harness dispatch (daemon-to-
 * daemon nesting is unproven). This MCP tool keeps subtask cluster-side:
 * the desktop calls it via mcp.url; the cluster runs runAgentLoop in-process.
 *
 * Adaptation from in-process built-in:
 * - `provider` is re-activated from `credentialId` via `ctx.aiProviders.activate()`
 *   (the built-in receives a pre-activated MeshProvider; the MCP tool only has the
 *   credential ID in the input, so it re-activates cluster-side).
 * - `writer` (UIMessageStreamWriter) is replaced by a no-op sink — the MCP tool
 *   returns the aggregated text directly instead of pushing to an in-process buffer.
 *   Data chunks emitted to the no-op writer (subtask metadata, tool metadata) are
 *   discarded; the desktop harness handles its own rendering from the returned result.
 * - `organization` is taken from `ctx.organization` (always set for authenticated MCP calls).
 * - `abortSignal` uses a local AbortController (MCP handlers do not expose the caller's signal).
 */
import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { createVirtualClientFrom } from "@/mcp-clients/virtual-mcp";
import { runAgentLoop } from "@/harnesses/decopilot/run-agent-loop";
import { SUBAGENT_STEP_LIMIT } from "@/api/routes/decopilot/constants";
import type { ModelsConfig } from "@/api/routes/decopilot/types";
import type { UIMessageStreamWriter } from "ai";

// Minimal no-op writer — discards all data chunks emitted by runAgentLoop
// (subtask-metadata, tool-metadata). The MCP tool returns the result text
// directly so the desktop harness can handle rendering.
const noopWriter: UIMessageStreamWriter = {
  write: () => {},
  merge: () => {},
  onError: () => {},
};

const SubtaskMcpInputSchema = z.object({
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
  credentialId: z
    .string()
    .min(1)
    .describe("Provider credential ID used to activate the language model."),
  thinkingModelId: z
    .string()
    .min(1)
    .describe("Thinking model ID to use for the subagent loop."),
  codingModelId: z.string().optional().describe("Optional coding model ID."),
  fastModelId: z.string().optional().describe("Optional fast model ID."),
});

export const SUBTASK_MCP = defineTool({
  name: "SUBTASK_MCP" as const,
  description:
    "Delegate a focused sub-task to a specialized agent. The subagent runs independently " +
    "cluster-side and returns its result as a structured text summary. " +
    "Use this when a task is better handled by a specialized agent, or to parallelize work.",
  inputSchema: SubtaskMcpInputSchema,
  outputSchema: z.object({ result: z.string(), finishReason: z.string() }),
  handler: async (input, ctx) => {
    await ctx.access.check();

    const organization = ctx.organization;
    if (!organization) throw new Error("Organization context required");

    // 1. Re-activate the provider from the credential ID (cluster-side).
    const provider = await ctx.aiProviders.activate(
      input.credentialId,
      organization.id,
    );

    // 2. Build a minimal ModelsConfig from the passed model IDs.
    const models: ModelsConfig = {
      credentialId: input.credentialId,
      thinking: {
        id: input.thinkingModelId,
        provider: provider.info.id,
        title: input.thinkingModelId,
      },
      ...(input.codingModelId
        ? {
            coding: {
              id: input.codingModelId,
              provider: provider.info.id,
              title: input.codingModelId,
            },
          }
        : {}),
      ...(input.fastModelId
        ? {
            fast: {
              id: input.fastModelId,
              provider: provider.info.id,
              title: input.fastModelId,
            },
          }
        : {}),
    };

    // 3. Validate the target agent.
    const virtualMcp = await ctx.storage.virtualMcps.findById(
      input.agent_id,
      organization.id,
    );
    if (!virtualMcp || virtualMcp.organization_id !== organization.id) {
      throw new Error("Agent not found");
    }
    if (virtualMcp.status !== "active") {
      throw new Error("Agent is not active");
    }

    // 4. Create MCP client for the target agent.
    const mcpClient = await createVirtualClientFrom(
      virtualMcp,
      ctx,
      "passthrough",
    );

    try {
      const abortController = new AbortController();

      // 5. Run the subagent loop. The writer is a no-op sink — the MCP tool
      //    returns the aggregated text directly instead of streaming to an
      //    in-process buffer.
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
        messages: [{ role: "user", content: input.prompt }],
        abortSignal: abortController.signal,
        stepLimit: SUBAGENT_STEP_LIMIT,
        toolApprovalLevel: "auto",
        planMode: false,
        writer: noopWriter,
        subtaskParams: { provider, organization, models },
        passthroughClient: mcpClient,
      });

      // 6. Drain the UI stream so streamText runs to completion.
      const reader = handle.result.toUIMessageStream().getReader();
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }

      // 7. Collect and return the result.
      const steps = await handle.result.steps;
      const finishReason = await handle.result.finishReason;
      const aggregatedText = steps
        .map((s) => s.text ?? "")
        .filter((t) => t.trim().length > 0)
        .join("\n\n")
        .trim();

      return {
        result: aggregatedText || "Subtask completed (no output).",
        finishReason: String(finishReason),
      };
    } finally {
      mcpClient.close().catch(() => {});
    }
  },
});
