/**
 * AUTOMATION_LIST Tool
 *
 * Lists automations for the current organization, including trigger counts.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";

export const AUTOMATION_LIST = defineTool({
  name: "AUTOMATION_LIST",
  description: "List automations for the current organization",
  annotations: {
    title: "List Automations",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    automations: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        active: z.boolean(),
        created_by: z.string(),
        created_at: z.string(),
        trigger_count: z.number(),
      }),
    ),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const automations = await ctx.storage.automations.listWithTriggerCounts(
      organization.id,
    );

    const results = automations.map((automation) => ({
      id: automation.id,
      name: automation.name,
      active: automation.active,
      created_by: automation.created_by,
      created_at: automation.created_at,
      trigger_count: automation.trigger_count,
    }));

    return { automations: results };
  },
});
