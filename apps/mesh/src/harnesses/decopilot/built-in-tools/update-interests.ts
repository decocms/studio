/**
 * update_interests Built-in Tool
 *
 * Lets the agent record what the user is durably working toward. Like
 * `todo_write`, the model passes the FULL list every call — it replaces the
 * stored one. The doc is scoped per (agent, user, org): each agent keeps its
 * own view and reads it back from the system prompt.
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { MeshContext } from "@/core/mesh-context";

const UpdateInterestsInputSchema = z.object({
  interests: z
    .array(
      z.object({
        title: z
          .string()
          .max(120)
          .describe("Short noun phrase, e.g. 'Learning Rust'"),
        summary: z
          .string()
          .max(500)
          .describe("One or two sentences of context, including any progress"),
      }),
    )
    .max(10),
});

export type UpdateInterestsInput = z.infer<typeof UpdateInterestsInputSchema>;

const description =
  "Record what the user is durably working toward (their goals/interests). " +
  "Call this when you learn a real, lasting goal — NOT for one-off questions. " +
  "Pass the FULL list every time: it replaces the stored one, so carry forward " +
  "existing interests (fold progress into their summary) and drop only ones " +
  "that are clearly finished or abandoned. Order by importance, most first.";

export function createUpdateInterestsTool(deps: {
  ctx: MeshContext;
  orgId: string;
  agentId: string;
  userId: string;
}) {
  return tool({
    description,
    inputSchema: zodSchema(UpdateInterestsInputSchema),
    execute: async ({ interests }: UpdateInterestsInput) => {
      await deps.ctx.storage.interests.setForAgent(
        deps.orgId,
        deps.agentId,
        deps.userId,
        { interests },
      );
      return { ok: true as const, count: interests.length };
    },
  });
}
