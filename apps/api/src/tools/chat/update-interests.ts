/**
 * update_interests — the user's durable goals, per (org, agent, user).
 *
 * The agent is the thread's, read from the path-scoped thread rather than
 * taken as input: a run must not write another agent's memory.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "@/core/studio-context";
import {
  UPDATE_INTERESTS_DESCRIPTION,
  UpdateInterestsInputSchema,
} from "@/harnesses/lib/decopilot/built-in-tools/update-interests";
import { requireTaskRunContext } from "../task-board/task-run-context";

export const UPDATE_INTERESTS = defineTool({
  name: "update_interests",
  description: UPDATE_INTERESTS_DESCRIPTION,
  annotations: {
    title: "Update Interests",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: UpdateInterestsInputSchema,
  outputSchema: z.object({ ok: z.literal(true), count: z.number() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const userId = getUserId(ctx);
    if (!userId) throw new Error("User ID required");
    const { threadId } = requireTaskRunContext();
    const thread = await ctx.storage.threads.get(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    await ctx.storage.interests.setForAgent(
      organization.id,
      thread.virtual_mcp_id,
      userId,
      { interests: input.interests },
    );
    return { ok: true as const, count: input.interests.length };
  },
});
