/**
 * AI-gateway admin client for top-up credits. Idempotent at the gateway per
 * referenceId (unique ledger index), so callers may retry freely.
 */

import { getSettings } from "../settings";

/** Whether this deployment can reach the gateway admin API at all
 *  (self-hosted deployments can't). */
export function gatewayAdminConfigured(): boolean {
  const settings = getSettings();
  return settings.aiGatewayEnabled && !!settings.aiGatewayAdminToken;
}

async function postGatewayAdmin(
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
 * Grant the one-time signup credit to a new org's gateway ledger. Idempotent
 * at the gateway per referenceId (unique ledger index): the deterministic
 * `signup-credit:<orgId>` reference collapses any replay — a re-run of
 * seedOrgDb, a retry — to a no-op, so the org is credited exactly once without
 * Studio holding any local "already granted" state.
 *
 * Fail-soft is the CALLER's job: org creation must never fail on a grant error
 * (see seedOrgDb), mirroring the auto-provision path.
 */
export async function grantGatewaySignupCredit(input: {
  organizationId: string;
  amountCents: number;
}): Promise<void> {
  if (!gatewayAdminConfigured()) {
    // Config was removed mid-flight; throw so the fail-soft caller logs it.
    throw new Error(
      "gateway admin not configured — cannot grant signup credit",
    );
  }
  await postGatewayAdmin(
    "/api/admin/credits",
    {
      orgId: input.organizationId,
      amountCents: input.amountCents,
      description: "Studio signup credit",
      referenceId: `signup-credit:${input.organizationId}`,
    },
    "gateway signup credit grant",
  );
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
