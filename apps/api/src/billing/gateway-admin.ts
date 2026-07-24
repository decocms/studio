/**
 * AI-gateway admin client bits shared by billing flows. The allowance grant
 * lives inside the benefits workflow (sync-org-benefits.ts); this module is
 * for one-shot admin calls with their own delivery guarantees.
 */

import { getSettings } from "../settings";

/**
 * Credit purchased AI credits to the org's gateway ledger. Idempotent at the
 * gateway per referenceId (unique ledger index), so callers may retry freely
 * — the top-up webhook THROWS on failure and lets Stripe's redelivery be the
 * retry queue.
 */
export async function creditGatewayTopUp(input: {
  organizationId: string;
  amountCents: number;
  referenceId: string;
}): Promise<void> {
  const settings = getSettings();
  if (!settings.aiGatewayEnabled || !settings.aiGatewayAdminToken) {
    // The top-up tool only offers the mesh checkout when the gateway admin is
    // configured, so reaching here means config was REMOVED mid-flight.
    // Throwing keeps the webhook redelivering until it's restored.
    throw new Error("gateway admin not configured — cannot credit top-up");
  }
  const res = await fetch(`${settings.aiGatewayUrl}/api/admin/credits`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.aiGatewayAdminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      orgId: input.organizationId,
      amountCents: input.amountCents,
      description: "Studio credit top-up (Stripe)",
      referenceId: input.referenceId,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`gateway top-up credit failed (${res.status}): ${body}`);
  }
}
