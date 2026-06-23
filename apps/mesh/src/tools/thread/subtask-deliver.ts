/**
 * THREAD_SUBTASK_DELIVER
 *
 * A desktop daemon runs a backgrounded `subtask` detached, in its own sandbox
 * (real vm/fs context), off the user's turn. When it finishes, the daemon calls
 * this over `/mcp/self` to deliver the subagent's report: it's persisted nested
 * under the subtask card and a reaction turn is enqueued so the parent agent can
 * act on it. Auth = the run's bearer (org/user from ctx) + the run fence token
 * (input) which must match the thread's active run. Identity never from input.
 */

import { z } from "zod";
import { fenceMatches } from "@/storage/run-fence";
import { deliverBackgroundSubtaskResult } from "@/harnesses/decopilot/background-tool-workflow";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";

const InputSchema = z.object({
  threadId: z.string(),
  /** Run fence token — must match the thread's active run fence. */
  fenceToken: z.string(),
  /** The originating subtask tool call's job id (`bgtool:<threadId>:<uuid>`). */
  jobId: z.string(),
  /** The subagent's final report (its `text` output). */
  report: z.string(),
  agentId: z.string(),
  temperature: z.number(),
  toolApprovalLevel: z.enum(["auto", "readonly"]),
  branch: z.string().nullable().optional(),
});

const OutputSchema = z.object({ ok: z.literal(true) });

export const THREAD_SUBTASK_DELIVER = defineTool({
  name: "THREAD_SUBTASK_DELIVER",
  description:
    "Deliver a backgrounded subtask's report back to its thread (persist + react). Called by desktop daemons — not by the model.",
  annotations: {
    title: "Deliver Subtask Result",
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
    const current = await ctx.storage.threads.getRunFence(input.threadId);
    if (current === null || !fenceMatches(current, input.fenceToken)) {
      throw new Error("Stale run fence");
    }

    await deliverBackgroundSubtaskResult({
      snapshot: {
        threadId: input.threadId,
        orgId: org.id,
        userId: ctx.auth.user!.id,
        agentId: input.agentId,
        temperature: input.temperature,
        toolApprovalLevel: input.toolApprovalLevel,
        branch: input.branch ?? null,
      },
      jobId: input.jobId,
      report: input.report,
    });

    return { ok: true as const };
  },
});
