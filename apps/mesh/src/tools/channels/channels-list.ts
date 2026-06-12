import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { isWhatsappConfigured } from "@/channels/whatsapp-worker";
import { CHANNEL_TYPES } from "./shared";

const platformSchema = z.object({
  id: z.enum(CHANNEL_TYPES),
  name: z.string(),
  description: z.string(),
  logo: z.string().optional(),
  setupInstructions: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      link: z.object({ label: z.string(), url: z.string() }).optional(),
    }),
  ),
});

/**
 * Static list of supported chat-channel platforms. Today only the shared
 * WhatsApp concierge — listed only when the worker is configured for this
 * deployment. Drives the "Add WhatsApp" button + its setup copy.
 */
export const CHANNELS_LIST = defineTool({
  name: "CHANNELS_LIST",
  description: "List supported chat channel platforms (WhatsApp).",
  annotations: { readOnlyHint: true, idempotentHint: true },
  inputSchema: z.object({}),
  outputSchema: z.object({
    platforms: z.array(platformSchema),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();

    const platforms: Array<z.infer<typeof platformSchema>> = [];
    if (isWhatsappConfigured()) {
      platforms.push({
        id: "whatsapp",
        name: "WhatsApp",
        description:
          "Let members chat with an agent over the shared decoCMS WhatsApp number.",
        logo: "whatsapp",
        setupInstructions: [
          {
            title: "Pick the agent that answers",
            description:
              "Choose the Decopilot agent that will respond to your members on WhatsApp. Members link their phone in their profile, then message the concierge number — it runs this agent as that member.",
          },
        ],
      });
    }

    return { platforms };
  },
});
