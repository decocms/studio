import z from "zod";
import { posthog } from "../../posthog";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";

/** Delete a chat channel integration. */
export const CHANNEL_DELETE = defineTool({
  name: "CHANNEL_DELETE",
  description: "Delete a chat channel integration.",
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ ok: z.boolean() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const existing = await ctx.storage.channels.findById(input.id, org.id);
    if (!existing) {
      throw new Error("Channel not found");
    }

    await ctx.storage.channels.delete(input.id, org.id);

    posthog.capture({
      distinctId: ctx.auth.user!.id,
      event: "channel_deleted",
      groups: { organization: org.id },
      properties: {
        organization_id: org.id,
        channel_id: input.id,
        channel_type: existing.channelType,
      },
    });

    return { ok: true };
  },
});
