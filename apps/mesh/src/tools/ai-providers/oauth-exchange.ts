import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { PROVIDER_IDS } from "../../ai-providers/provider-ids";
import { PROVIDERS } from "../../ai-providers/registry";

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
  outputSchema: z.object({
    id: z.string(),
    providerId: z.string(),
    label: z.string(),
    createdAt: z.string(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const adapter = PROVIDERS[input.providerId];
    if (
      !adapter.supportedMethods.includes("oauth-pkce") ||
      !adapter.exchangeOAuthCode
    ) {
      throw new Error(
        `Provider ${input.providerId} does not support OAuth PKCE`,
      );
    }

    const codeVerifier = await ctx.storage.oauthPkceStates.consume(
      input.stateToken,
      org.id,
      ctx.auth.user!.id,
    );

    const { apiKey } = await adapter.exchangeOAuthCode({
      code: input.code,
      codeVerifier,
      codeChallengeMethod: "S256",
    });

    const key = await ctx.storage.aiProviderKeys.create({
      providerId: input.providerId,
      label: input.label,
      apiKey,
      organizationId: org.id,
      createdBy: ctx.auth.user!.id,
    });

    return {
      id: key.id,
      providerId: key.providerId,
      label: key.label,
      createdAt: key.createdAt,
    };
  },
});
