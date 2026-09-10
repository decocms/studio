import type { PlanEntitlements, ProviderAdapter } from "../types";
import { openrouterAdapter } from "./openrouter";
import { getSettings } from "../../settings";

function getBase(): string {
  return getSettings().aiGatewayUrl ?? "https://ai-site.deco.site";
}

/**
 * The entitlements payload, exactly as the gateway sends it (snake_case). Two
 * routes return it — GET /entitlements and PUT /plan — so it is parsed and
 * mapped in one place; the shapes drifted apart the last time they weren't.
 */
interface EntitlementsWire {
  plan: { id: string; name: string };
  features: Record<string, boolean>;
  usage: { percent: number; state: "ok" | "warn" | "exhausted" } | null;
  credits: { remaining_usd: number } | null;
  /** Server-only: the gateway sends it only to a caller holding the service
   *  key, or to an org that owns `model_choice`. */
  model_pins?: Record<string, string> | null;
  tasks: {
    allowed: boolean;
    remaining: number | null;
    denyReason: string | null;
  };
  period_start: string;
  period_end: string;
  /** Emitted by the gateway; not yet used for revalidation. */
  etag?: string;
}

/**
 * A refusal the gateway names with a `code`, carried through instead of being
 * flattened into "Failed to change plan: 503".
 *
 * The gateway emits two of these on the plan routes — `plans_disabled` (its own
 * PLANS_ENABLED is off, which is a deliberate dormant state and not an outage)
 * and `service_key_required`. Both used to surface to the user as an opaque
 * HTTP 500 carrying a status number: an operator mid-rollout, with mesh's flag
 * on and the gateway's still off, saw "Couldn't change plan: Failed to change
 * plan: 503" and no way to tell that from the gateway being down.
 */
export class GatewayRefusalError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "GatewayRefusalError";
  }
}

/** The gateway's `{error, code}` body, when it sent one. */
async function refusal(
  res: Response,
  what: string,
): Promise<GatewayRefusalError> {
  const body = (await res.json().catch(() => null)) as {
    error?: string;
    code?: string;
  } | null;
  const code = typeof body?.code === "string" ? body.code : null;
  const plans = code === "plans_disabled";
  return new GatewayRefusalError(
    res.status,
    code,
    plans
      ? "Plans are not enabled on the AI gateway yet."
      : (body?.error ?? `${what}: ${res.status}`),
  );
}

/**
 * A failed entitlements read, carrying the status so the gate can tell a
 * DEFINITIVE refusal from an outage.
 *
 * They are different incidents with the same consequence (the gate has no
 * answer and opens): a 4xx is a misconfiguration or a rejected identity —
 * retrying will not fix it and it needs a human — while a 5xx or a network
 * error is a blip that will pass. Collapsing both into one thrown string made
 * a fleet-wide "the paid product is free for everyone" indistinguishable from a
 * momentary hiccup.
 */
export class EntitlementsFetchError extends Error {
  constructor(readonly status: number) {
    super(`Failed to fetch plan entitlements: ${status}`);
    this.name = "EntitlementsFetchError";
  }

  /** A definitive answer from a reachable gateway — not an outage. */
  get isDefinitive(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

function toPlanEntitlements(data: EntitlementsWire): PlanEntitlements {
  return {
    plan: data.plan,
    features: data.features,
    usage: data.usage,
    credits: data.credits ? { remainingUsd: data.credits.remaining_usd } : null,
    modelPins: data.model_pins ?? null,
    tasks: data.tasks,
    periodStart: data.period_start,
    periodEnd: data.period_end,
  };
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
    studioJwt: string,
    orgId: string,
    amountCents: number,
    currency: "usd" | "brl" = "usd",
  ) {
    // DEAD FALLBACK: the gateway retired /api/credits/checkout — studio owns
    // the top-up flow now — so this 404s, on this branch and on the gateway's
    // main. `getTopUpUrl` in tools/ai-providers prefers mesh's own Stripe and
    // only reaches here when that is unconfigured, which is why the 404 has
    // been read as "Stripe absent" rather than "route gone". Kept, and
    // labelled, because deleting it is a product decision about whether the
    // gateway ever serves checkout again.
    const res = await fetch(`${getBase()}/api/credits/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${studioJwt}`,
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

  async getCreditsBalance(studioJwt: string, organizationId: string) {
    // Same identification as the entitlements read: the gateway now checks
    // membership on this route (it did not, which let any signed-in user read
    // any org's balance), and that check runs over a PER-USER gateway-OAuth
    // token most users have never minted. The service key says "mesh's server
    // is asking about an org it owns" and skips that callback.
    const serviceKey = getSettings().studioProvisionSecretKey;
    const res = await fetch(
      `${getBase()}/api/teams/${organizationId}/balance`,
      {
        headers: {
          Authorization: `Bearer ${studioJwt}`,
          ...(serviceKey ? { "X-Provision-Key": serviceKey } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      throw new Error(`Failed to fetch credits balance: ${res.status}`);
    }
    const data = (await res.json()) as { balance_cents: number };
    return { balanceCents: data.balance_cents };
  },

  async getEntitlements(studioJwt: string, organizationId: string) {
    // `X-Provision-Key` identifies mesh's SERVER — the same header the key
    // provisioning call already uses. It is what makes the gateway include the
    // org's pinned MODEL: §6 withholds the model's name from the org itself,
    // and this request is the one caller that is not the org. Absent on a
    // self-hosted deployment, which then simply gets no pins.
    const serviceKey = getSettings().studioProvisionSecretKey;
    const res = await fetch(
      `${getBase()}/api/teams/${organizationId}/entitlements`,
      {
        headers: {
          Authorization: `Bearer ${studioJwt}`,
          ...(serviceKey ? { "X-Provision-Key": serviceKey } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      throw new EntitlementsFetchError(res.status);
    }
    return toPlanEntitlements((await res.json()) as EntitlementsWire);
  },

  async listPlans(studioJwt: string, organizationId: string) {
    const res = await fetch(`${getBase()}/api/teams/${organizationId}/plans`, {
      headers: { Authorization: `Bearer ${studioJwt}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw await refusal(res, "Failed to fetch plans");
    const data = (await res.json()) as {
      plans: { id: string; name: string; features: Record<string, boolean> }[];
    };
    return data.plans;
  },

  async setPlan(studioJwt: string, organizationId: string, planId: string) {
    // SERVICE-ONLY on the gateway: a plan change takes no payment and asks for
    // no confirmation, so the gateway refuses anyone who cannot prove they are
    // mesh's server. Mesh is the side that owns the role check and the charge.
    // Without this header the gateway answers 403 `service_key_required`.
    const serviceKey = getSettings().studioProvisionSecretKey;
    if (!serviceKey) {
      throw new Error("STUDIO_PROVISION_SECRET_KEY is not set");
    }
    const res = await fetch(`${getBase()}/api/teams/${organizationId}/plan`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${studioJwt}`,
        "X-Provision-Key": serviceKey,
      },
      body: JSON.stringify({ planId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw await refusal(res, "Failed to change plan");
    return toPlanEntitlements((await res.json()) as EntitlementsWire);
  },

  async provisionKey(studioJwt: string, organizationId: string) {
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
        Authorization: `Bearer ${studioJwt}`,
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
