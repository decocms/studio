import z from "zod";
import { posthog } from "../../posthog";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { generatePrefixedId } from "@/shared/utils/generate-id";
import { CHANNEL_TYPES, channelOutputSchema, toChannelOutput } from "./shared";

/**
 * Enable a chat channel for the org. WhatsApp is a shared-number, enable-only
 * channel: it just binds the agent that answers and goes straight to `active`
 * (no credentials, no bot — the real verified user answers).
 */
export const CHANNEL_CREATE = defineTool({
  name: "CHANNEL_CREATE",
  description:
    "Enable a chat channel (WhatsApp) and bind the agent that answers.",
  inputSchema: z.object({
    channelType: z.enum(CHANNEL_TYPES),
    label: z.string().min(1).max(100).optional(),
    agentId: z.string().min(1),
  }),
  outputSchema: channelOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const info = await ctx.storage.channels.create({
      id: generatePrefixedId("chan"),
      channelType: input.channelType,
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

    return toChannelOutput(info);
  },
});
