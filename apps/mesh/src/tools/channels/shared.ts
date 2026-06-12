import z from "zod";
import type { ChannelInfo } from "@/storage/types";

export const CHANNEL_TYPES = ["whatsapp"] as const;

const channelStatusSchema = z.enum(["draft", "active", "error", "disabled"]);

/** Public output shape for a channel — never carries secrets. */
export const channelOutputSchema = z.object({
  id: z.string(),
  channelType: z.enum(CHANNEL_TYPES),
  label: z.string(),
  agentId: z.string().nullable(),
  status: channelStatusSchema,
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});

export type ChannelOutput = z.infer<typeof channelOutputSchema>;

export function toChannelOutput(info: ChannelInfo): ChannelOutput {
  return {
    id: info.id,
    channelType: info.channelType,
    label: info.label,
    agentId: info.agentId,
    status: info.status,
    metadata: info.metadata,
    createdAt: info.createdAt,
  };
}
