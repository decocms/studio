import type { OAuthPkceResult, ProviderAdapter } from "../types";
import { openrouterAdapter } from "./openrouter";

const BASE = process.env.DECO_AI_GATEWAY_URL ?? "https://ai-site.decocache.com";

export const decoAiGatewayAdapter: ProviderAdapter = {
  info: {
    id: "openrouter",
    name: "Deco AI Gateway",
    description: "Deco-managed keys with access to 100+ models",
    logo: "/logos/deco logo.svg",
  },

  supportedMethods: ["oauth-pkce", "api-key"],

  getOAuthUrl({
    callbackUrl,
    codeChallenge,
    codeChallengeMethod,
    organizationId,
  }: {
    callbackUrl: string;
    codeChallenge: string;
    codeChallengeMethod: "S256";
    organizationId: string;
  }) {
    const params = new URLSearchParams({
      redirect_uri: callbackUrl,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      organization_id: organizationId,
    });
    const url = `${BASE}/oauth/authorize?${params}`;
    return url;
  },

  async exchangeOAuthCode({ code, codeVerifier }): Promise<OAuthPkceResult> {
    const res = await fetch(`${BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`Deco AI Gateway OAuth exchange failed: ${res.status}`);
    }
    const data = await res.json();
    return { apiKey: data.key };
  },

  create(apiKey) {
    const base = openrouterAdapter.create(apiKey);
    return { ...base, info: this.info };
  },
};
