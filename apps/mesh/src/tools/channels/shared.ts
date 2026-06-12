import z from "zod";
import { getBaseUrl } from "@/core/server-constants";
import type { ChannelInfo, ChannelType } from "@/storage/types";

export const CHANNEL_TYPES = ["teams", "discord", "whatsapp"] as const;

export const channelStatusSchema = z.enum([
  "draft",
  "active",
  "error",
  "disabled",
]);

/** Public output shape for a channel — never carries secrets. */
export const channelOutputSchema = z.object({
  id: z.string(),
  channelType: z.enum(CHANNEL_TYPES),
  label: z.string(),
  agentId: z.string().nullable(),
  botUserId: z.string().nullable(),
  status: channelStatusSchema,
  webhookUrl: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});

export type ChannelOutput = z.infer<typeof channelOutputSchema>;

/**
 * The inbound webhook URL the platform must call. Embeds the org slug and
 * channel id so `resolveOrgFromPath` + the channel lookup can route + verify.
 */
export function buildWebhookUrl(
  orgSlug: string,
  channelId: string,
  channelType: ChannelType,
): string {
  return `${getBaseUrl().replace(/\/$/, "")}/api/${orgSlug}/channels/${channelId}/${channelType}`;
}

export function toChannelOutput(
  info: ChannelInfo,
  orgSlug: string,
): ChannelOutput {
  return {
    id: info.id,
    channelType: info.channelType,
    label: info.label,
    agentId: info.agentId,
    botUserId: info.botUserId,
    status: info.status,
    webhookUrl: buildWebhookUrl(orgSlug, info.id, info.channelType),
    metadata: info.metadata,
    createdAt: info.createdAt,
  };
}
