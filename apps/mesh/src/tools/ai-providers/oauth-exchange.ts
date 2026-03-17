import z from "zod";
import { defineTool } from "../../core/define-tool";
import {
  requireAuth,
  requireOrganization,
  getUserId,
} from "../../core/mesh-context";
import { PROVIDER_IDS } from "../../ai-providers/provider-ids";
import { PROVIDERS } from "../../ai-providers/registry";
import { providerKeyOutputSchema } from "./key-create";

export const AI_PROVIDER_OAUTH_EXCHANGE = defineTool({
  name: "AI_PROVIDER_OAUTH_EXCHANGE",
  description:
    "Exchange an OAuth authorization code for an API key and store it",
  inputSchema: z.object({
    providerId: z.enum(PROVIDER_IDS),
    code: z.string(),
    stateToken: z
      .string()
      .describe("The stateToken returned by AI_PROVIDER_OAUTH_URL"),
    label: z.string().min(1).max(100).default("Connected via OAuth"),
  }),
  outputSchema: providerKeyOutputSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const adapter = PROVIDERS[input.providerId];
    if (!adapter) {
      throw new Error(`Unknown provider: ${input.providerId}`);
    }
    if (
      !adapter.supportedMethods.includes("oauth-pkce") ||
      !adapter.exchangeOAuthCode
    ) {
      throw new Error(
        `Provider ${input.providerId} does not support OAuth PKCE`,
      );
    }

    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    const codeVerifier = await ctx.storage.oauthPkceStates.consume(
      input.stateToken,
      org.id,
      userId,
    );

    const { apiKey } = await adapter.exchangeOAuthCode({
      code: input.code,
      codeVerifier,
      codeChallengeMethod: "S256",
    });

    const key = await ctx.storage.aiProviderKeys.upsert({
      providerId: input.providerId,
      label: input.label,
      apiKey,
      organizationId: org.id,
      createdBy: userId,
    });

    return {
      id: key.id,
      providerId: key.providerId,
      label: key.label,
      createdAt: key.createdAt,
    };
  },
});
