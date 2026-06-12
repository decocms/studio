import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { getChannelAdapter } from "@/channels/registry";
import { CHANNEL_TYPES, buildWebhookUrl, channelStatusSchema } from "./shared";

/**
 * Detailed view of a single channel, including masked credentials. Used by the
 * edit dialog and the wizard's success summary. Never returns raw secrets.
 */
export const CHANNEL_PREVIEW = defineTool({
  name: "CHANNEL_PREVIEW",
  description:
    "Get a channel's details with masked credentials (for editing / setup resume).",
  annotations: { readOnlyHint: true },
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({
    id: z.string(),
    channelType: z.enum(CHANNEL_TYPES),
    label: z.string(),
    agentId: z.string().nullable(),
    status: channelStatusSchema,
    webhookUrl: z.string(),
    /** Masked credential values keyed by field; empty object for drafts. */
    maskedCredentials: z.record(z.string(), z.string()),
    metadata: z.record(z.string(), z.unknown()).nullable(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const { info, credentials } = await ctx.storage.channels.resolve(
      input.id,
      org.id,
    );
    const adapter = getChannelAdapter(info.channelType);

    return {
      id: info.id,
      channelType: info.channelType,
      label: info.label,
      agentId: info.agentId,
      status: info.status,
      webhookUrl: buildWebhookUrl(
        org.slug ?? org.id,
        info.id,
        info.channelType,
      ),
      maskedCredentials: credentials
        ? adapter.maskCredentials(credentials)
        : {},
      metadata: info.metadata,
    };
  },
});
