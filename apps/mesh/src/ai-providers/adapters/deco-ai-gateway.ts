import type { ProviderAdapter } from "../types";
import { openrouterAdapter } from "./openrouter";
import { getSettings } from "../../settings";

function getBase(): string {
  return getSettings().aiGatewayUrl ?? "https://ai-site.deco.site";
}

export const decoAiGatewayAdapter: ProviderAdapter = {
  info: {
    id: "deco",
    name: "Deco AI Gateway",
    description: "Deco-managed keys with access to 100+ models",
    logo: "/logos/deco logo.svg",
  },

  supportedMethods: ["api-key"],

  async getTopUpUrl(
    meshJwt: string,
    orgId: string,
    amountCents: number,
    currency: "usd" | "brl" = "usd",
  ) {
    const res = await fetch(`${getBase()}/api/credits/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${meshJwt}`,
      },
      body: JSON.stringify({ teamId: orgId, amountCents, currency }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`Failed to create top-up checkout: ${res.status}`);
    }
    const data = (await res.json()) as { url: string };
    return data.url;
  },

  async getCreditsBalance(meshJwt: string, organizationId: string) {
    const res = await fetch(
      `${getBase()}/api/teams/${organizationId}/balance`,
      {
        headers: { Authorization: `Bearer ${meshJwt}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      throw new Error(`Failed to fetch credits balance: ${res.status}`);
    }
    const data = (await res.json()) as { balance_cents: number };
    return { balanceCents: data.balance_cents };
  },

  async provisionKey(meshJwt: string, organizationId: string) {
    const studioProvisionSecretKey =
      getSettings().studioProvisionSecretKey ?? "";
    if (!studioProvisionSecretKey) {
      throw new Error("STUDIO_PROVISION_SECRET_KEY is not set");
    }
    const res = await fetch(`${getBase()}/api/keys/provision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Provision-Key": studioProvisionSecretKey,
        Authorization: `Bearer ${meshJwt}`,
      },
      body: JSON.stringify({ organization_id: organizationId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`Deco AI Gateway key provisioning failed: ${res.status}`);
    }
    const data = (await res.json()) as { key: string };
    return data.key;
  },

  create(apiKey) {
    const base = openrouterAdapter.create(apiKey);
    return { ...base, info: this.info };
  },
};
