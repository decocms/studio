import z from "zod";
import { posthog } from "../../posthog";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { PROVIDER_IDS } from "../../ai-providers/provider-ids";

export const providerKeyOutputSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  label: z.string(),
  presetId: z.string().nullable(),
  createdAt: z.string(),
});

export const AI_PROVIDER_KEY_CREATE = defineTool({
  name: "AI_PROVIDER_KEY_CREATE",
  description:
    "Store an API key for an AI provider. The key is encrypted at rest in the vault.",
  inputSchema: z.object({
    providerId: z.enum(PROVIDER_IDS),
    label: z.string().min(1).max(100),
    apiKey: z.string().min(1),
    presetId: z.string().min(1).max(64).optional(),
  }),
  outputSchema: providerKeyOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const key = await ctx.storage.aiProviderKeys.create({
      providerId: input.providerId,
      label: input.label,
      apiKey: input.apiKey,
      organizationId: org.id,
      createdBy: ctx.auth.user!.id,
      presetId: input.presetId ?? null,
    });

    posthog.capture({
      distinctId: ctx.auth.user!.id,
      event: "ai_provider_key_created",
      groups: { organization: org.id },
      properties: {
        organization_id: org.id,
        provider_id: key.providerId,
        preset_id: key.presetId,
        key_id: key.id,
        label: key.label,
      },
    });

    return {
      id: key.id,
      providerId: key.providerId,
      label: key.label,
      presetId: key.presetId,
      createdAt: key.createdAt,
    };
  },
});
