import z from "zod";
import { defineTool } from "../../core/define-tool";
import {
  requireAuth,
  requireOrganization,
  getUserId,
} from "../../core/mesh-context";
import { PROVIDER_IDS } from "../../ai-providers/provider-ids";
import { getProviders } from "../../ai-providers/registry";
import { mintGatewayJwt } from "../../auth/jwt";
import { providerKeyOutputSchema } from "./key-create";

export const AI_PROVIDER_PROVISION_KEY = defineTool({
  name: "AI_PROVIDER_PROVISION_KEY",
  description:
    "Auto-provision an API key for a provider that supports server-to-server key creation (e.g. Deco AI Gateway).",
  inputSchema: z.object({
    providerId: z.enum(PROVIDER_IDS),
  }),
  outputSchema: providerKeyOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    const adapter = getProviders()[input.providerId];
    if (!adapter) {
      throw new Error(`Unknown provider: ${input.providerId}`);
    }
    if (!adapter.provisionKey) {
      throw new Error(
        `Provider ${input.providerId} does not support key provisioning`,
      );
    }

    const meshJwt = await mintGatewayJwt(userId);
    const apiKey = await adapter.provisionKey(meshJwt, org.id);

    const key = await ctx.storage.aiProviderKeys.upsert({
      providerId: input.providerId,
      label: "Auto-provisioned",
      apiKey,
      organizationId: org.id,
      createdBy: userId,
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
