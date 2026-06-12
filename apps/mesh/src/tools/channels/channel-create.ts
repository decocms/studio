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

    const channelId = generatePrefixedId("chan");

    // WhatsApp is a shared-number, enable-only channel: no synthetic bot, no
    // credentials/endpoint/test — the real verified user answers. It requires an
    // agent and goes straight to `active`.
    if (input.channelType === "whatsapp") {
      if (!input.agentId) {
        throw new Error("WhatsApp channels require an agent");
      }
      const info = await ctx.storage.channels.create({
        id: channelId,
        channelType: "whatsapp",
        label: input.label ?? "WhatsApp",
        botUserId: null,
        agentId: input.agentId,
        status: "active",
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
    }

    const adapter = getChannelAdapter(input.channelType);
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
