/**
 * POST /api/_stripe/webhook — Stripe event intake (org-subscription billing).
 *
 * Instance-level (underscore namespace, mounted before the /api/:org
 * catch-all) and deliberately OUTSIDE any session/admin auth: the caller is
 * Stripe, authenticated exclusively by the signature over the RAW body.
 * 503 when the deployment has no webhook secret (self-hosted: Stripe billing
 * simply doesn't exist there).
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getSettings } from "../../settings";
import {
  parseStripeEvent,
  processStripeEvent,
  verifyStripeSignature,
} from "../../billing/stripe-webhook";

// Stripe events are small; the route is unauthenticated, so cap the body
// before buffering it (same pattern as trigger-callback).
const MAX_BODY_SIZE = 1_048_576; // 1MB

export const stripeWebhookRoutes = new Hono();

stripeWebhookRoutes.post(
  "/webhook",
  bodyLimit({
    maxSize: MAX_BODY_SIZE,
    onError: (c) => c.json({ error: "payload too large" }, 413),
  }),
  async (c) => {
    const secret = getSettings().stripeWebhookSecret;
    if (!secret) {
      return c.json({ error: "stripe billing not configured" }, 503);
    }

    // Raw body FIRST — the signature covers the exact bytes, any parse-then-
    // restringify would break verification.
    const rawBody = await c.req.text();
    const ok = verifyStripeSignature(
      rawBody,
      c.req.header("stripe-signature"),
      secret,
    );
    if (!ok) {
      return c.json({ error: "invalid signature" }, 400);
    }

    const event = parseStripeEvent(rawBody);
    if (!event) {
      return c.json({ error: "invalid payload" }, 400);
    }

    // Always 200 for verified events — handlers are idempotent, and unknown
    // orgs/events/stale deliveries are acknowledged no-ops (a Stripe
    // redelivery wouldn't help). A thrown handler error falls through to 500
    // so Stripe DOES redeliver. One log line per event — the audit trail for
    // a source-of-truth money writer.
    const result = await processStripeEvent(event);
    console.log("stripe webhook", {
      eventId: event.id,
      type: event.type,
      livemode: event.livemode,
      ...result,
    });
    return c.json({ received: true });
  },
);
