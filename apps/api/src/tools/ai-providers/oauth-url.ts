import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { PROVIDER_IDS } from "../../ai-providers/provider-ids";
import { getProviders } from "../../ai-providers/registry";
import {
  generateCodeVerifier,
  generateCodeChallenge,
} from "../../ai-providers/pkce";
import { getSettings } from "../../settings";

function isLocalhostAlias(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function isAllowedCallbackOrigin(callbackUrl: string): boolean {
  const settings = getSettings();
  const base = settings.baseUrl ?? `http://localhost:${settings.port}`;
  const callback = new URL(callbackUrl);
  const baseUrl = new URL(base);

  if (callback.origin === baseUrl.origin) return true;

  return (
    callback.protocol === baseUrl.protocol &&
    isLocalhostAlias(callback.hostname) &&
    isLocalhostAlias(baseUrl.hostname)
  );
}

export const AI_PROVIDER_OAUTH_URL = defineTool({
  name: "AI_PROVIDER_OAUTH_URL",
  description:
    "Get the OAuth PKCE authorization URL for a provider. Returns URL and state token.",
  inputSchema: z.object({
    providerId: z.enum(PROVIDER_IDS),
    callbackUrl: z
      .string()
      .url()
      .refine(
        (url) => {
          return isAllowedCallbackOrigin(url);
        },
        { message: "callbackUrl must be on the same origin as BASE_URL" },
      ),
  }),
  outputSchema: z.object({
    url: z.string(),
    stateToken: z
      .string()
      .describe("Opaque token — pass to AI_PROVIDER_OAUTH_EXCHANGE"),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const adapter = getProviders()[input.providerId];
    if (!adapter) {
      throw new Error(`Unknown provider: ${input.providerId}`);
    }
    if (
      !adapter.supportedMethods.includes("oauth-pkce") ||
      !adapter.getOAuthUrl
    ) {
      throw new Error(
        `Provider ${input.providerId} does not support OAuth PKCE`,
      );
    }

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    const stateToken = await ctx.storage.oauthPkceStates.create(
      codeVerifier,
      org.id,
      ctx.auth.user!.id,
    );

    // Embed stateToken in the callbackUrl so providers that don't pass state
    // back in their redirect (e.g. OpenRouter) still round-trip it via the URL.
    const callbackWithState = new URL(input.callbackUrl);
    callbackWithState.searchParams.set("state", stateToken);

    const oauthParams = {
      callbackUrl: callbackWithState.toString(),
      codeChallenge,
      codeChallengeMethod: "S256" as const,
      organizationId: org.id,
    };
    const url = adapter.getOAuthUrl(oauthParams);

    return { url, stateToken };
  },
});
