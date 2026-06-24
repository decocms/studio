/**
 * THREAD_BACKGROUND_TOOL_START
 *
 * Enqueue a slow built-in (generate_image) as a durable cluster job so a
 * desktop-linked run doesn't block its turn. Replaces the old fence-authed
 * `POST /api/:org/threads/:threadId/background-tool` route: the daemon already
 * holds the run's MCP credentials, so it calls this over `/mcp/self` instead of
 * a bespoke endpoint. Auth = the run's bearer (org/user from ctx); the fence
 * token (passed as input) must match the thread's active run. Identity is never
 * read from the input.
 */

import { z } from "zod";
import { isCancelRequested } from "@/storage/cancel-flag";
import { fenceMatches } from "@/storage/run-fence";
import { createBackgroundToolDispatcher } from "@/harnesses/decopilot/background-tool-workflow";
import { GenerateImageInputSchema } from "@decocms/harness/decopilot/built-in-tools/portable-media-tools";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";

// Subtask payload the workflow's `subtask` producer reads (prompt + optional
// target agent). Kept minimal — the producer re-resolves models/target itself.
const SubtaskBgInputSchema = z.object({
  prompt: z.string(),
  agent_id: z.string().optional(),
});

// NOTE: the management registration only accepts a top-level `ZodObject` (it
// checks for `.shape`), so this MUST stay a flat object — a discriminatedUnion
// silently registers as an empty schema. `input` is validated per `toolName`
// in the handler below (not forwarded unvalidated).
const InputSchema = z.object({
  threadId: z.string(),
  /** Run fence token — must match the thread's active run fence. */
  fenceToken: z.string(),
  toolName: z.enum(["generate_image", "subtask"]),
  input: z.unknown(),
  toolCallId: z.string(),
  agentId: z.string(),
  temperature: z.number(),
  toolApprovalLevel: z.enum(["auto", "readonly"]),
  branch: z.string().nullable().optional(),
});

const OutputSchema = z.object({ jobId: z.string() });

export const THREAD_BACKGROUND_TOOL_START = defineTool({
  name: "THREAD_BACKGROUND_TOOL_START",
  description:
    "Enqueue a slow built-in tool (generate_image or subtask) as a durable background job on the active run's thread. Used by desktop daemons — not called by the model.",
  annotations: {
    title: "Start Background Tool",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: InputSchema,
  outputSchema: OutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const thread = await ctx.storage.threads.get(input.threadId);
    if (!thread || thread.organization_id !== org.id) {
      throw new Error("Thread not found in organization");
    }

    const cancelAt = await ctx.storage.threads.getCancelRequestedAt(
      input.threadId,
    );
    if (isCancelRequested(cancelAt)) {
      throw new Error("Run cancelled");
    }

    const current = await ctx.storage.threads.getRunFence(input.threadId);
    if (current === null || !fenceMatches(current, input.fenceToken)) {
      throw new Error("Stale run fence");
    }

    // Validate the payload against the real per-tool schema here (a compromised
    // daemon can't push an unvalidated shape into the heavy work).
    const toolInput =
      input.toolName === "generate_image"
        ? GenerateImageInputSchema.parse(input.input)
        : SubtaskBgInputSchema.parse(input.input);

    const dispatcher = createBackgroundToolDispatcher({
      threadId: input.threadId,
      orgId: org.id,
      userId: ctx.auth.user!.id,
      agentId: input.agentId,
      temperature: input.temperature,
      toolApprovalLevel: input.toolApprovalLevel,
      branch: input.branch ?? null,
    });
    const { jobId } = await dispatcher.start({
      toolName: input.toolName,
      input: toolInput,
      toolCallId: input.toolCallId,
    });

    return { jobId };
  },
});
