/** PLAN_GOAL_SUGGEST: proposes Plan goals; a member saves the ones they accept with PLAN_GOAL_CREATE. */

import { z } from "zod";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import { defineTool } from "@/core/define-tool";
import {
  findBrandGoals,
  SuggestResultSchema,
} from "../organization/plan-goal-find";
import { caller } from "./caller";

export const PLAN_GOAL_SUGGEST = defineTool({
  name: "PLAN_GOAL_SUGGEST",
  description:
    "Look for goals in what the brand's people wrote and said: the organization memory, text files a person uploaded, and the organization's connections (meetings, messages, documents). Returns up to six goals the organization does not have yet, each with the verbatim quote behind it and where it was found, checked by Jev, or why none was found. Never infers goals from metrics and saves nothing.",
  annotations: {
    title: "Suggest Plan Goals",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({}),
  outputSchema: SuggestResultSchema,

  handler: async (_input, ctx) => {
    const who = await caller(ctx);
    const settings = await ctx.storage.organizationSettings.get(who.orgId);
    if (!orgFlagEnabled(settings?.flags, "plan_page_enabled")) {
      throw new Error("The Plan page is not enabled for this organization");
    }
    const goals = await ctx.storage.planGoals.list(
      who.orgId,
      who.userId,
      who.admin,
    );
    return findBrandGoals(ctx, who.orgId, {
      existing: goals.map((goal) => goal.statement),
    });
  },
});
