import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { getChannelAdapter } from "@/channels/registry";
import { channelOutputSchema, toChannelOutput } from "./shared";

/**
 * Update a channel's label, bound agent, and/or credentials. Credentials are
 * validated against the platform adapter's schema and stored vault-encrypted.
 */
export const CHANNEL_UPDATE = defineTool({
  name: "CHANNEL_UPDATE",
  description:
    "Update a channel's label, bound Decopilot agent, or platform credentials.",
  inputSchema: z.object({
    id: z.string(),
    label: z.string().min(1).max(100).optional(),
    agentId: z.string().min(1).nullable().optional(),
    // Per-platform credential object; validated against the adapter schema.
    credentials: z.record(z.string(), z.unknown()).optional(),
  }),
  outputSchema: channelOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const existing = await ctx.storage.channels.findById(input.id, org.id);
    if (!existing) {
      throw new Error("Channel not found");
    }

    let credentials: Record<string, unknown> | undefined;
    if (input.credentials !== undefined) {
      const adapter = getChannelAdapter(existing.channelType);
      const parsed = adapter.credentialSchema.safeParse(input.credentials);
      if (!parsed.success) {
        throw new Error(
          `Invalid ${existing.channelType} credentials: ${parsed.error.message}`,
        );
      }
      credentials = parsed.data as Record<string, unknown>;
    }

    const info = await ctx.storage.channels.update(input.id, org.id, {
      label: input.label,
      agentId: input.agentId,
      credentials,
    });

    return toChannelOutput(info, org.slug ?? org.id);
  },
});
