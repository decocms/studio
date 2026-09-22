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

/** A gateway refusal that retrying cannot fix. Carried as a type rather than a
 *  status check at each call site, because only the webhook's THROW/ACK choice
 *  depends on it. */
export class GatewayAdminPermanentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GatewayAdminPermanentError";
  }
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
  // Drain the body on every path — otherwise the connection isn't released back to the pool.
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    // A 4xx from a gateway that ANSWERED is a decision, not an outage: an
    // unknown plan id, a malformed body, a rejected token. The gateway's plans
    // route returns 400 for every one of them. Retrying a decision changes
    // nothing, and the caller here is a Stripe webhook — so throwing would
    // 500 the route and have Stripe redeliver a deterministic failure on its
    // full schedule, which ends with Stripe DISABLING the endpoint and every
    // org's billing events going with it. Distinguish it so the webhook can
    // acknowledge loudly instead. 408/429 are excluded: those do pass.
    const permanent =
      res.status >= 400 &&
      res.status < 500 &&
      res.status !== 408 &&
      res.status !== 429;
    const message = `${label} failed (${res.status}): ${text}`;
    throw permanent
      ? new GatewayAdminPermanentError(res.status, message)
      : new Error(message);
  }
}

/**
 * Place the org on a gateway plan.
 *
 * Through the gateway's ADMIN route, not the user-facing
 * `PUT /api/teams/:orgId/plan`: that one requires a user JWT and there is no
 * user in a webhook. The admin token is the right authority here anyway — the
 * caller is Stripe telling us what was paid for.
 *
 * `free` is a real plan id at the gateway; the gateway's admin route routes it
 * through `removeOrgPlan`, so a cancellation also clears any per-org override.
 * THROWS on failure: the webhook lets Stripe redeliver, and placing a plan is
 * idempotent.
 *
 * The two unconfigured cases are NOT the same, and collapsing them into one
 * silent `return` is what made a paid upgrade grant nothing and a cancellation
 * revoke nothing, with no log, no throw and no boot check — against this
 * docblock, the caller's own comment and the rollout doc, all three of which
 * say it throws. Stripe saw a 200 and never redelivered, and `AI_PLAN_SET`
 * cannot repair it because it accepts nothing but `free`.
 */
export async function setGatewayOrgPlan(input: {
  organizationId: string;
  planId: string;
  note: string;
}): Promise<void> {
  const settings = getSettings();
  if (!settings.aiGatewayEnabled) {
    // No gateway in this deployment (self-hosted), so there are no
    // entitlements to place. Not an error: the subscription itself is still
    // valid and the billing row is still written.
    return;
  }
  if (!settings.aiGatewayAdminToken) {
    // There IS a gateway and we cannot write to it. That is a payment taken
    // for an entitlement never granted, so it throws and Stripe retries until
    // the token is restored — exactly what `creditGatewayTopUp` does, for a
    // liability that is no larger.
    throw new Error(
      "DECO_AI_GATEWAY_ADMIN_TOKEN is not set — cannot place the gateway plan",
    );
  }
  await postGatewayAdmin(
    "/api/admin/plans",
    {
      orgId: input.organizationId,
      planId: input.planId,
      note: input.note,
    },
    "gateway plan change",
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
