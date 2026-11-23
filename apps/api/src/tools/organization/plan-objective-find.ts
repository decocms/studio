/** ORGANIZATION_PLAN_OBJECTIVE_FIND — proposes the store goal; a member saves it with ORGANIZATION_PLAN_OBJECTIVE_SET. */

import { z } from "zod";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import {
  FindResultSchema,
  findBrandGoals,
  firstFinding,
} from "./plan-goal-find";

export const ORGANIZATION_PLAN_OBJECTIVE_FIND = defineTool({
  name: "ORGANIZATION_PLAN_OBJECTIVE_FIND",
  description:
    "Look for the store goal in what the brand's people wrote and said: the organization memory, text files a person uploaded, and the organization's connections (meetings, messages, documents). Returns one sentence with the verbatim quote behind it and where it was found, checked by Jev, or why no clear goal was found. Never infers the goal from metrics and does not save it.",
  annotations: {
    title: "Find Store Goal",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({}),
  outputSchema: FindResultSchema,

  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const org = requireOrganization(ctx);
    const settings = await ctx.storage.organizationSettings.get(org.id);
    if (!orgFlagEnabled(settings?.flags, "plan_page_enabled")) {
      throw new Error("The Plan page is not enabled for this organization");
    }
    return firstFinding(await findBrandGoals(ctx, org.id));
  },
});
