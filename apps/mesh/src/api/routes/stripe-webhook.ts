/**
 * POST /api/_stripe/webhook — Stripe event intake (per-seat billing).
 *
 * Instance-level (underscore namespace, mounted before the /api/:org
 * catch-all) and deliberately OUTSIDE any session/admin auth: the caller is
 * Stripe, authenticated exclusively by the signature over the RAW body.
 * 503 when the deployment has no webhook secret (self-hosted: Stripe billing
 * simply doesn't exist there).
 */

import { Hono } from "hono";
import { getSettings } from "../../settings";
import {
  processStripeEvent,
  verifyStripeSignature,
  type StripeEvent,
} from "../../billing/stripe-webhook";

export const stripeWebhookRoutes = new Hono();

stripeWebhookRoutes.post("/webhook", async (c) => {
  const secret = getSettings().stripeWebhookSecret;
  if (!secret) {
    return c.json({ error: "stripe billing not configured" }, 503);
  }

  // Raw body FIRST — the signature covers the exact bytes, any parse-then-
  // restringify would break verification.
  const rawBody = await c.req.text();
  const ok = await verifyStripeSignature(
    rawBody,
    c.req.header("stripe-signature"),
    secret,
  );
  if (!ok) {
    return c.json({ error: "invalid signature" }, 400);
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return c.json({ error: "invalid payload" }, 400);
  }
  if (
    typeof event?.type !== "string" ||
    typeof event?.data?.object !== "object"
  ) {
    return c.json({ error: "invalid payload" }, 400);
  }

  // Always 200 for verified events — handlers are idempotent and unknown
  // orgs/events are acknowledged no-ops (a Stripe redelivery wouldn't help).
  // A thrown handler error falls through to 500 so Stripe DOES redeliver.
  const result = await processStripeEvent(event);
  return c.json(result);
});
