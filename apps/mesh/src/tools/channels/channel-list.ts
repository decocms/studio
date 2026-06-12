import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { CHANNEL_TYPES, channelOutputSchema, toChannelOutput } from "./shared";

/** List the org's configured channels (drafts and active). */
export const CHANNEL_LIST = defineTool({
  name: "CHANNEL_LIST",
  description:
    "List configured chat channel integrations for the organization.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  inputSchema: z.object({
    channelType: z.enum(CHANNEL_TYPES).optional(),
  }),
  outputSchema: z.object({
    channels: z.array(channelOutputSchema),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const list = await ctx.storage.channels.list({
      organizationId: org.id,
      channelType: input.channelType,
    });

    return {
      channels: list.map((info) => toChannelOutput(info, org.slug ?? org.id)),
    };
  },
});
