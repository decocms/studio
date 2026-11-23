/**
 * ORGANIZATION_PLAN_OBJECTIVE_SET — write the store goal on the Plan page.
 *
 * A member-writable companion to ORGANIZATION_SETTINGS_UPDATE, like the blocks
 * editor switch: any member who plans for the store can state its goal, so
 * this lives in basic-usage while the general settings tool stays behind
 * org:manage. It writes only `plan_objective`, and the author and time come
 * from the session, not from the caller.
 */

import { z } from "zod";
import {
  PLAN_OBJECTIVE_MAX_LENGTH,
  PlanObjectiveSchema,
} from "@decocms/shared/organization/schema";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";

export const ORGANIZATION_PLAN_OBJECTIVE_SET = defineTool({
  name: "ORGANIZATION_PLAN_OBJECTIVE_SET",
  description:
    "Set the store goal shown on the Plan page, in one sentence, or clear it with null. From a chat, save only a sentence the person approved there.",
  annotations: {
    title: "Set Store Goal",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    statement: z
      .string()
      .trim()
      .min(1, "Write the goal, or send null to clear it.")
      .max(PLAN_OBJECTIVE_MAX_LENGTH)
      .nullable()
      .describe(
        "The store goal in one sentence, in the person's own words. null clears it.",
      ),
  }),
  outputSchema: z.object({
    plan_objective: PlanObjectiveSchema.nullable(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const org = requireOrganization(ctx);
    const userId = getUserId(ctx);
    if (!userId) throw new Error("A signed-in user is required");

    const objective =
      input.statement === null
        ? null
        : {
            statement: input.statement,
            updated_by: userId,
            updated_at: new Date().toISOString(),
          };
    const settings = await ctx.storage.organizationSettings.setPlanObjective(
      org.id,
      objective,
    );
    return { plan_objective: settings.plan_objective };
  },
});
