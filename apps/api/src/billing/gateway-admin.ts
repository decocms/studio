/**
 * AI-gateway admin client shared by the billing flows (allowance grants,
 * top-up credits). Every call is idempotent at the gateway per referenceId
 * (unique ledger index), so callers may retry freely.
 */

import { getSettings } from "../settings";

/** Whether this deployment can reach the gateway admin API at all
 *  (self-hosted deployments can't). */
export function gatewayAdminConfigured(): boolean {
  const settings = getSettings();
  return settings.aiGatewayEnabled && !!settings.aiGatewayAdminToken;
}

export async function postGatewayAdmin(
  path: string,
  body: Record<string, unknown>,
  label: string,
): Promise<void> {
  const settings = getSettings();
  const res = await fetch(`${settings.aiGatewayUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.aiGatewayAdminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${label} failed (${res.status}): ${text}`);
  }
}

/**
 * Credit purchased AI credits to the org's gateway ledger. The top-up webhook
 * THROWS on failure and lets Stripe's redelivery be the retry queue — the
 * gateway referenceId dedupe makes every replay a no-op.
 */
export async function creditGatewayTopUp(input: {
  organizationId: string;
  amountCents: number;
  referenceId: string;
}): Promise<void> {
  if (!gatewayAdminConfigured()) {
    // The top-up tool only offers the mesh checkout when the gateway admin is
    // configured, so reaching here means config was REMOVED mid-flight.
    // Throwing keeps the webhook redelivering until it's restored.
    throw new Error("gateway admin not configured — cannot credit top-up");
  }
  await postGatewayAdmin(
    "/api/admin/credits",
    {
      orgId: input.organizationId,
      amountCents: input.amountCents,
      description: "Studio credit top-up (Stripe)",
      referenceId: input.referenceId,
    },
    "gateway top-up credit",
  );
}
