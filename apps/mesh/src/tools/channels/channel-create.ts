import z from "zod";
import { posthog } from "../../posthog";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { generatePrefixedId } from "@/shared/utils/generate-id";
import { ensureChannelBot } from "@/channels/bot-identity";
import { getChannelAdapter } from "@/channels/registry";
import { CHANNEL_TYPES, channelOutputSchema, toChannelOutput } from "./shared";

/**
 * Create a channel as a `draft`. Provisions the synthetic bot org-member and
 * returns the inbound webhook URL so the admin can configure the platform
 * portal before pasting credentials. Credentials are added later via
 * CHANNEL_UPDATE; CHANNEL_TEST flips the channel to `active`.
 */
export const CHANNEL_CREATE = defineTool({
  name: "CHANNEL_CREATE",
  description:
    "Create a draft chat channel integration and provision its bot. Returns the inbound webhook URL to configure on the platform.",
  inputSchema: z.object({
    channelType: z.enum(CHANNEL_TYPES),
    label: z.string().min(1).max(100).optional(),
    agentId: z.string().min(1).optional(),
  }),
  outputSchema: channelOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const adapter = getChannelAdapter(input.channelType);
    const channelId = generatePrefixedId("chan");
    const label = input.label ?? `${adapter.info.name} bot`;

    const { botUserId } = await ensureChannelBot({
      db: ctx.db,
      organizationId: org.id,
      channelId,
      displayName: label,
    });

    const info = await ctx.storage.channels.create({
      id: channelId,
      channelType: input.channelType,
      label,
      botUserId,
      agentId: input.agentId ?? null,
      status: "draft",
      organizationId: org.id,
      createdBy: ctx.auth.user!.id,
    });

    posthog.capture({
      distinctId: ctx.auth.user!.id,
      event: "channel_created",
      groups: { organization: org.id },
      properties: {
        organization_id: org.id,
        channel_id: info.id,
        channel_type: info.channelType,
      },
    });

    return toChannelOutput(info, org.slug ?? org.id);
  },
});
