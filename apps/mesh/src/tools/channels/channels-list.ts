import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { getChannelAdapters } from "@/channels/registry";
import { isWhatsappConfigured } from "@/channels/whatsapp-worker";
import { CHANNEL_TYPES } from "./shared";

const platformSchema = z.object({
  id: z.enum(CHANNEL_TYPES),
  name: z.string(),
  description: z.string(),
  logo: z.string().optional(),
  setupKind: z.enum(["credentials", "shared"]),
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
});

/**
 * Static list of supported chat-channel platforms and their setup metadata.
 * Drives the page's per-platform "Add" buttons + the wizard.
 *
 * `setupKind`:
 *  - "credentials" — per-org webhook platforms (Teams, Discord): paste creds,
 *    set an endpoint, test.
 *  - "shared" — the WhatsApp concierge: enable-only (pick an agent); members
 *    verify their phone in their profile. Only listed when configured.
 */
export const CHANNELS_LIST = defineTool({
  name: "CHANNELS_LIST",
  description:
    "List supported chat channel platforms (Teams, Discord, WhatsApp) with their setup instructions and credential fields.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  inputSchema: z.object({}),
  outputSchema: z.object({
    platforms: z.array(platformSchema),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();

    const platforms: Array<z.infer<typeof platformSchema>> = Object.values(
      getChannelAdapters(),
    ).map((adapter) => ({
      id: adapter.info.id,
      name: adapter.info.name,
      description: adapter.info.description,
      logo: adapter.info.logo,
      setupKind: "credentials",
      credentialFields: adapter.credentialFields,
      setupInstructions: adapter.setupInstructions,
    }));

    // WhatsApp is a shared-number, enable-only channel — listed only when the
    // concierge worker is configured for this deployment.
    if (isWhatsappConfigured()) {
      platforms.push({
        id: "whatsapp",
        name: "WhatsApp",
        description:
          "Let members chat with an agent over the shared decoCMS WhatsApp number.",
        logo: "whatsapp",
        setupKind: "shared",
        credentialFields: [],
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
