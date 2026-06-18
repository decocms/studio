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
import { resolveSubagent } from "../resolve-subagent";
import type { ToolSet, UIMessageStreamWriter } from "ai";
import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { MeshProvider } from "@/ai-providers/types";
import type { ModelsConfig } from "@decocms/harness/types";
import { runAgentLoop } from "../run-agent-loop";
import { SUBAGENT_STEP_LIMIT } from "@decocms/harness/decopilot/prompt-constants";
import { acquireSubagentSlot } from "./subagent-concurrency";
import type { CodingWorkspacePromptInput } from "@decocms/harness/coding-workspace-prompt";

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
    .optional()
    .describe(
      "The ID of the agent (Virtual MCP) to delegate to. Must exist and be " +
        "active in the current organization. OMIT to clone yourself — a fresh " +
        "subagent with your exact tools and instructions but an empty context.",
    ),
});

export type SubtaskInput = z.infer<typeof SubtaskInputSchema>;

const SUBTASK_DESCRIPTION =
  "Run a focused task in a fresh subagent that works independently and returns only its conclusion.\n\n" +
  "USE THIS FOR DISCOVERY. Before an open-ended search, or before reading more than ~3 files / resources / " +
  "records to answer a question, call subtask FIRST instead of doing it inline — the subagent spends ITS " +
  "context on the digging and hands back just the answer, keeping yours focused and cheap. A single, " +
  "targeted lookup you already know the shape of stays inline.\n\n" +
  "OMIT agent_id to clone yourself (a fresh subagent with your exact tools and instructions, empty context). " +
  "Pass agent_id to delegate to a different, specialized agent instead.\n\n" +
  "Usage notes:\n" +
  "- Every subtask call starts FRESH — no conversation history, no prior runs. Always include full context in the prompt and state exactly what to return (the specific answer/list/paths you need, not a raw dump); never use continuation phrases like 'continue' or 'as before'.\n" +
  "- Clearly tell the subagent whether you expect it to take action or just research.\n" +
  "- To parallelize independent searches, launch multiple subtask calls in the same message.\n" +
  "- The subagent's output should generally be trusted.";

export interface SubtaskParams {
  provider: MeshProvider;
  organization: OrganizationScope;
  models: ModelsConfig;
  codingWorkspace?: CodingWorkspacePromptInput;
  needsApproval?: boolean;
  /**
   * The calling agent's own Virtual MCP id. When present, omitting `agent_id`
   * (or passing this id) clones the calling agent: a fresh subagent over the
   * SAME Virtual MCP — identical tools + instructions, empty context. The clone
   * opens its own superUser passthrough client (mirroring the parent's tool
   * scope), so it is fully isolated from the parent loop.
   * Absent on paths with no self context (e.g. subagents, which can't subtask
   * at all): omitting `agent_id` there is an error.
   */
  self?: {
    id: string;
  };
  /**
   * Usage roll-up sink (Task 17). When present, the subtask tool calls this
   * with each completed child run's token totals so the PARENT run's usage
   * accumulator can fold them into its final `message-metadata.usage` (the
   * kernel sees one number). The cluster adapter wires this to
   * `usageAccumulator.addExternal` for `kind: "main"` runs; absent on subtask
   * runs (which expose no subtask tool — depth-1).
   */
  onChildUsage?: (usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }) => void;
  /**
   * The parent's already-built VM sandbox tools (read/write/edit/grep/glob/
   * bash/…), bound to the parent's sandbox via its fs hooks. Forwarded to a
   * SELF-CLONE subagent so it works in the SAME sandbox — its file writes are
   * visible to the parent. Absent for cross-agent delegation (different agent =
   * different sandbox identity) and when the parent has no sandbox (no
   * vmContext, e.g. Claude Code).
   */
  vmTools?: ToolSet;
}

export function resolveSubtaskCodingWorkspace(
  targetRef: { repo?: { owner: string; name: string } },
  parentWorkspace?: CodingWorkspacePromptInput,
): CodingWorkspacePromptInput | undefined {
  if (!targetRef.repo) return parentWorkspace;

  return {
    repo: {
      owner: targetRef.repo.owner,
      name: targetRef.repo.name,
      connectedGithub: true,
    },
    branch: parentWorkspace?.branch,
    cwd: parentWorkspace?.cwd,
    workspaceKind: "github",
  };
}

/** Max chars of a tool call's args shown in the live subtask stream. */
const TOOL_CALL_ARG_CAP = 80;

/** Render a subagent tool call as a short, capped one-liner for the stream. */
function formatToolCall(toolName: string, input: unknown): string {
  let args = "";
  try {
    args = typeof input === "string" ? input : JSON.stringify(input ?? {});
  } catch {
    args = "";
  }
  if (args === "{}") args = "";
  if (args.length > TOOL_CALL_ARG_CAP) {
    args = args.slice(0, TOOL_CALL_ARG_CAP) + "…";
  }
  return args ? `${toolName} ${args}` : toolName;
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
  const {
    provider,
    organization,
    models,
    needsApproval,
    self,
    onChildUsage,
    vmTools,
    codingWorkspace,
  } = params;

  return tool({
    description: SUBTASK_DESCRIPTION,
    inputSchema: zodSchema(SubtaskInputSchema),
    needsApproval,
    execute: async function* (
      { prompt, agent_id },
      { abortSignal, toolCallId },
    ) {
      const startTime = performance.now();

      // Self-subtask: omit agent_id (or pass the caller's own id) to clone the
      // current agent — a fresh subagent over the SAME Virtual MCP, with
      // identical tools + instructions but an empty context.
      const isSelf = !!self && (!agent_id || agent_id === self.id);
      const targetId = isSelf ? self!.id : agent_id;

      // Recoverable failures yield a structured error (surfaced to the model
      // via toModelOutput) and stop, instead of throwing. Throwing before the
      // first yield kills the subtask with no guidance, so the model can't
      // self-correct and just repeats the mistake. A yielded error lets it
      // retry — usually by omitting agent_id to clone itself.
      // Base hint: always offer the self-clone path. The "pass an agent id from
      // <available-agents>" pointer is appended ONLY when a catalog actually
      // exists (see the allowlist branch below) — a dangling pointer is what
      // makes the model fabricate agent ids instead of just omitting agent_id.
      const cloneHint = self
        ? " Omit agent_id to clone yourself (a fresh subagent with your tools + instructions)."
        : "";

      if (!targetId) {
        yield {
          text: "",
          error: `agent_id is required here.${cloneHint}`,
          finishReason: "error",
        };
        return;
      }

      // 1. Enforce the caller's sub-agent allowlist for cross-agent delegation
      //    BEFORE resolving the target. Self-clones are always allowed (isSelf
      //    short-circuits). An empty/absent allowlist means "all agents".
      if (!isSelf && self) {
        const caller = await ctx.storage.virtualMcps.findById(
          self.id,
          organization.id,
        );
        const allow = caller?.metadata?.subAgents;
        // An allowlist array (even empty = itself only) gates cross-agent
        // delegation. A null/absent allowlist means all agents are allowed.
        if (Array.isArray(allow) && !allow.includes(targetId)) {
          // Point at the catalog ONLY when the allowlist permits some other
          // agent. An empty allowlist (self-only) has no <available-agents>
          // table, so directing the model there just makes it invent ids.
          const catalogHint =
            allow.length > 0
              ? " Or pass an agent id from <available-agents>."
              : "";
          yield {
            text: "",
            error: `Agent '${targetId}' is not in this agent's delegation allowlist (allow=${JSON.stringify(allow)}).${cloneHint}${catalogHint}`,
            finishReason: "error",
          };
          return;
        }
      }

      // 2. Validate the target and open its passthrough client. A self-clone
      //    uses superUser so its tool scope mirrors the parent loop. Resolution
      //    errors ("Agent not found" / "not active") are also recoverable.
      let resolved: Awaited<ReturnType<typeof resolveSubagent>>;
      try {
        resolved = await resolveSubagent(ctx, organization.id, targetId, {
          superUser: isSelf,
        });
      } catch (err) {
        yield {
          text: "",
          error: `${(err as Error).message} (agent_id="${targetId}").${cloneHint}`,
          finishReason: "error",
        };
        return;
      }
      const { mcpClient, targetRef } = resolved;
      const targetLabel = targetRef.id;

      const releaseSlot = await acquireSubagentSlot();
      try {
        const subtaskCodingWorkspace = resolveSubtaskCodingWorkspace(
          targetRef,
          codingWorkspace,
        );

        // 3. Call runAgentLoop with subagent kind.
        const handle = await runAgentLoop({
          kind: "subagent",
          ctx,
          organization,
          virtualMcp: targetRef,
          mcpClient,
          provider,
          models,
          messages: [{ role: "user", content: prompt }],
          abortSignal: abortSignal ?? new AbortController().signal,
          stepLimit: SUBAGENT_STEP_LIMIT,
          toolApprovalLevel: "auto",
          planMode: false,
          codingWorkspace: subtaskCodingWorkspace,
          writer,
          subtaskParams: {
            provider,
            organization,
            models,
            needsApproval,
            codingWorkspace: subtaskCodingWorkspace,
          },
          // Subagent inherits the parent's writer for nested chunk routing.
          // Subagent gets prompts/connections blocks via the MCP client
          // (which is both the tool source AND the prompts source for the
          // target agent). This passes through to buildAgentSystemPrompt.
          passthroughClient: mcpClient,
          // Self-clone only: inherit the parent's sandbox tools so the clone
          // runs bash / file I/O against the SAME sandbox. A different agent
          // has a different sandbox identity, so it must NOT inherit these.
          extraTools: isSelf ? vmTools : undefined,
        });

        let streamedText = "";
        let lastFlush = 0;
        const FLUSH_MS = 200;
        for await (const part of handle.result.fullStream) {
          if (part.type === "text-delta") {
            streamedText += part.text;
            const now = performance.now();
            if (now - lastFlush >= FLUSH_MS) {
              lastFlush = now;
              yield { text: streamedText };
            }
          } else if (part.type === "tool-call") {
            // Surface the subagent's tool executions in the live stream so the
            // UI shows progress even while the subagent is working silently
            // (calling tools, not emitting text). Args are capped to a few
            // tokens — enough to identify the call, not a full dump.
            const sep =
              streamedText && !streamedText.endsWith("\n") ? "\n" : "";
            streamedText += `${sep}↳ ${formatToolCall(part.toolName, part.input)}\n`;
            lastFlush = performance.now();
            yield { text: streamedText };
          }
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
          `[subtask:${targetLabel}${isSelf ? ":self" : ""}] completed: finishReason=${finishReason}, steps=${steps.length}, textLength=${aggregatedText.length}, error=${error ? "yes" : "no"}, usage=${JSON.stringify({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens })}`,
        );

        // 6. Roll the child's usage into the PARENT run's accumulator so the
        //    parent's final `message-metadata.usage` includes child tokens
        //    (Task 17 — the kernel sees one number). Per-subtask detail still
        //    rides the `data-tool-subtask-metadata` chunk below.
        onChildUsage?.({
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          totalTokens: usage.totalTokens ?? 0,
        });

        // 6b. Emit metadata chunks to the parent's writer.
        const latencyMs = performance.now() - startTime;
        writer.write({
          type: "data-tool-metadata",
          id: toolCallId,
          data: { annotations: SUBTASK_ANNOTATIONS, latencyMs },
        });
        writer.write({
          type: "data-tool-subtask-metadata",
          id: toolCallId,
          data: { usage, agent: targetLabel, models },
        });

        // 7. Yield the structured result as the ONLY (and therefore
        //    final) value. The AI SDK's executeTool helper uses the
        //    LAST YIELDED value as `output` for toModelOutput — the
        //    generator's return value is discarded. Yielding here
        //    keeps the parent's UI payload tiny and the model output
        //    correct.
        yield { text: aggregatedText, error, finishReason };
      } finally {
        releaseSlot();
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
