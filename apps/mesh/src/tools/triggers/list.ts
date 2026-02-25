import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { TriggerListOutputSchema } from "./schema";

export const TRIGGER_LIST = defineTool({
  name: "TRIGGER_LIST",
  description: "List all triggers for the organization",
  annotations: {
    title: "List Triggers",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: TriggerListOutputSchema,
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const triggers = await ctx.storage.triggers.list(organization.id);
    return { triggers };
  },
});
