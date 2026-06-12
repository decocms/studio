import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { getChannelAdapters } from "@/channels/registry";
import { CHANNEL_TYPES } from "./shared";

/**
 * Static list of supported chat-channel platforms and their setup metadata.
 * Drives the wizard's platform grid, credential form, and instructions.
 */
export const CHANNELS_LIST = defineTool({
  name: "CHANNELS_LIST",
  description:
    "List supported chat channel platforms (Teams, Discord) with their setup instructions and credential fields.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  inputSchema: z.object({}),
  outputSchema: z.object({
    platforms: z.array(
      z.object({
        id: z.enum(CHANNEL_TYPES),
        name: z.string(),
        description: z.string(),
        logo: z.string().optional(),
        credentialFields: z.array(
          z.object({
            key: z.string(),
            label: z.string(),
            placeholder: z.string().optional(),
            secret: z.boolean().optional(),
            optional: z.boolean().optional(),
            help: z.string().optional(),
          }),
        ),
        setupInstructions: z.array(
          z.object({
            title: z.string(),
            description: z.string(),
            link: z.object({ label: z.string(), url: z.string() }).optional(),
          }),
        ),
      }),
    ),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();

    const platforms = Object.values(getChannelAdapters()).map((adapter) => ({
      id: adapter.info.id,
      name: adapter.info.name,
      description: adapter.info.description,
      logo: adapter.info.logo,
      credentialFields: adapter.credentialFields,
      setupInstructions: adapter.setupInstructions,
    }));
    return { platforms };
  },
});
