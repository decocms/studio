import type { OAuthPkceResult, ProviderAdapter } from "../types";
import { openrouterAdapter } from "./openrouter";
import { env } from "../../env";

const BASE = env.DECO_AI_GATEWAY_URL ?? "https://ai-site.decocache.com";

export const decoAiGatewayAdapter: ProviderAdapter = {
  info: {
    id: "deco",
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
    return `${BASE}/oauth/authorize?${params}`;
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

  async getTopUpUrl(
    apiKey: string,
    amountCents: number,
    currency: "usd" | "brl" = "usd",
  ) {
    const res = await fetch(`${BASE}/api/credits/topup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ amountCents, currency }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`Failed to create top-up checkout: ${res.status}`);
    }
    const data = (await res.json()) as { url: string };
    return data.url;
  },

  async getCreditsBalance(meshJwt: string, organizationId: string) {
    const res = await fetch(`${BASE}/api/teams/${organizationId}/balance`, {
      headers: { Authorization: `Bearer ${meshJwt}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch credits balance: ${res.status}`);
    }
    const data = (await res.json()) as { balance_cents: number };
    return { balanceCents: data.balance_cents };
  },

  create(apiKey) {
    const base = openrouterAdapter.create(apiKey);
    return { ...base, info: this.info };
  },
};
