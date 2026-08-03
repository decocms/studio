/**
 * local-subtask — the portable (`@/*`-free) `subtask` built-in for environments
 * that run delegated subagents IN-PROCESS via the shared core `spawnSubtask`
 * (Task 18 desktop). Unlike the cluster `subtask.ts` (which threads
 * `StudioContext`, validates the target agent against `ctx.storage`, and drives
 * `runAgentLoop`), this tool delegates ALL environment-specific work to the
 * injected `runSubtask` closure: the adapter builds the TARGET-agent core deps
 * (self-clone or cross-agent) and calls `spawnSubtask`.
 *
 * The environment-independent surface — `SUBTASK_DESCRIPTION`,
 * `SubtaskInputSchema`, `SUBTASK_ANNOTATIONS`, the `data-tool-metadata` +
 * `data-tool-subtask-metadata` chunk emission, the `onChildUsage` roll-up, and
 * the `toModelOutput` error/step-limit/text formatting — is copied VERBATIM
 * from the cluster `subtask.ts` so the model sees an identical tool on both
 * sides.
 *
 * Depth-1, step budget, concurrency cap, and signal chaining are enforced by
 * `spawnSubtask` → `runDecopilotCore({ kind: "subtask" })` inside the adapter's
 * `runSubtask` closure (not here).
 */

import { tool, zodSchema, type UIMessageStreamWriter } from "ai";
import { z } from "zod";
import type { ModelsConfig } from "../../types";
import type { SubtaskRunResult } from "../run-core";

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
      "The ID of an agent (Virtual MCP) or concrete MCP connection to delegate " +
        "to. A concrete connection creates an ephemeral subagent scoped to that " +
        "connection. OMIT to clone yourself — a fresh subagent with your exact " +
        "tools and instructions but an empty context.",
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
  "Pass agent_id to delegate to a different specialized agent, or to create an ephemeral subagent for a " +
  "concrete MCP connection. Use IDs exactly as listed in <available-agents> or <available-connections>.\n\n" +
  "Usage notes:\n" +
  "- Every subtask call starts FRESH — no conversation history, no prior runs. Always include full context in the prompt and state exactly what to return (the specific answer/list/paths you need, not a raw dump); never use continuation phrases like 'continue' or 'as before'.\n" +
  "- Clearly tell the subagent whether you expect it to take action or just research.\n" +
  "- To parallelize independent searches, launch multiple subtask calls in the same message.\n" +
  "- The subagent's output should generally be trusted.";

const SUBTASK_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export interface LocalSubtaskParams {
  /** The parent run's writer — the subtask emits its metadata data chunks here
   *  so they interleave into the parent UI stream. */
  writer: UIMessageStreamWriter;
  /** The calling agent's own Virtual MCP id. Omitting `agent_id` (or passing
   *  this id) clones the calling agent: a fresh subagent over the SAME target,
   *  identical tools + instructions, empty context. */
  selfAgentId: string;
  /** Slot-keyed harness models for this run. Threaded onto the
   *  `data-tool-subtask-metadata` chunk so it carries the same `{usage, agent,
   *  models}` shape the cluster `subtask.ts` emits — the `ToolSubtaskMetadata`
   *  interface declares `models` as required, so omitting it was a type lie. */
  models: ModelsConfig;
  /** Tool-approval gate forwarded from the desktop tool assembly. */
  needsApproval?: boolean;
  /**
   * Environment-specific delegated run. The adapter builds the TARGET-agent
   * core deps — self-clone (`targetAgentId === undefined`) or cross-agent
   * (`targetAgentId` set) — and calls `spawnSubtask`. The parent tool-call
   * `signal` is chained in so cancelling the parent kills the subtask.
   */
  runSubtask: (
    prompt: string,
    targetAgentId: string | undefined,
    signal: AbortSignal,
  ) => Promise<SubtaskRunResult>;
  /**
   * Usage roll-up sink (Task 17). Called with each completed child run's token
   * totals so the PARENT run's usage accumulator folds them into its final
   * `message-metadata.usage` (the kernel sees one number). Per-subtask detail
   * still rides the `data-tool-subtask-metadata` chunk.
   */
  onChildUsage?: (usage: SubtaskRunResult["usage"]) => void;
}

export function createLocalSubtaskTool(params: LocalSubtaskParams) {
  const {
    writer,
    selfAgentId,
    models,
    needsApproval,
    runSubtask,
    onChildUsage,
  } = params;

  return tool({
    description: SUBTASK_DESCRIPTION,
    inputSchema: zodSchema(SubtaskInputSchema),
    needsApproval,
    execute: async ({ prompt, agent_id }, { abortSignal, toolCallId }) => {
      const startTime = performance.now();
      // `undefined` target = self-clone; an explicit, different agent_id =
      // cross-agent delegation. The adapter resolves the actual target.
      const target =
        agent_id && agent_id !== selfAgentId ? agent_id : undefined;

      const result = await runSubtask(
        prompt,
        target,
        abortSignal ?? new AbortController().signal,
      );

      // Roll the child's usage into the PARENT run's accumulator so the
      // parent's final `message-metadata.usage` includes child tokens (Task 17
      // — the kernel sees one number). Per-subtask detail rides the
      // `data-tool-subtask-metadata` chunk below.
      onChildUsage?.(result.usage);

      writer.write({
        type: "data-tool-metadata",
        id: toolCallId,
        data: {
          annotations: SUBTASK_ANNOTATIONS,
          latencyMs: performance.now() - startTime,
        },
      });
      writer.write({
        type: "data-tool-subtask-metadata",
        id: toolCallId,
        data: { usage: result.usage, agent: target ?? selfAgentId, models },
      });

      // Returned shape is consumed by toModelOutput (text/error/finishReason).
      return result;
    },
    toModelOutput: ({ output }) => {
      const o = output as
        | { text?: string; error?: string; finishReason?: string }
        | undefined;
      if (o?.error) {
        // Kept in sync with the cluster `subtask.ts`: hand back whatever the
        // subagent DID produce before it died, so the parent doesn't redo work
        // whose side effects already landed.
        const partial = o.text?.trim();
        return {
          type: "error-text" as const,
          value: partial
            ? `Subtask failed: ${o.error}\n\nPartial result produced before the failure (its tool calls already ran — do not repeat them blindly):\n\n${partial}`
            : `Subtask failed: ${o.error}`,
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
