/**
 * Minimal Stripe API client for the per-seat billing surface: first-subscribe
 * Checkout, prorated seat-change preview, and the quantity update that
 * charges the difference. Raw fetch + form encoding (Stripe's API is
 * form-encoded), same no-SDK posture as the reports worker and the gateway —
 * three endpoints don't buy a dependency.
 *
 * Proration model (the plan's "pay the difference now" flow):
 *  - previewSeatChange → POST /v1/invoices/create_preview with the new
 *    quantity: Stripe returns exactly "new total minus what this cycle
 *    already paid", which the members-page apply bar renders.
 *  - applySeatQuantity → POST /v1/subscriptions/:id with
 *    proration_behavior=always_invoice: charges/credits the prorated
 *    difference immediately on the saved card. payment_behavior=
 *    pending_if_incomplete leaves the subscription consistent when the card
 *    demands 3DS — the webhook narrates whatever lands.
 */

import { getSettings } from "../settings";

const BASE_URL = "https://api.stripe.com/v1";

export class StripeApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`Stripe API ${status}: ${message}`);
    this.name = "StripeApiError";
  }
}

/** Flatten nested params into Stripe's bracket form encoding:
 *  { line_items: [{ price: "p", quantity: 2 }] } →
 *  line_items[0][price]=p & line_items[0][quantity]=2 */
export function toStripeForm(
  params: Record<string, unknown>,
  prefix = "",
  out: URLSearchParams = new URLSearchParams(),
): URLSearchParams {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === "object" && item !== null) {
          toStripeForm(item as Record<string, unknown>, `${name}[${i}]`, out);
        } else {
          out.append(`${name}[${i}]`, String(item));
        }
      });
    } else if (typeof value === "object") {
      toStripeForm(value as Record<string, unknown>, name, out);
    } else {
      out.append(name, String(value));
    }
  }
  return out;
}

async function stripeRequest<T>(
  path: string,
  params: Record<string, unknown>,
): Promise<T> {
  const key = getSettings().stripeSecretKey;
  if (!key) throw new StripeApiError(503, "STRIPE_SECRET_KEY not configured");
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: toStripeForm(params).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message =
      ((body.error as Record<string, unknown> | undefined)?.message as
        | string
        | undefined) ?? `HTTP ${res.status}`;
    throw new StripeApiError(res.status, message);
  }
  return body as T;
}

/** First subscribe: Checkout collects + saves the card; afterwards every
 *  seat change is an inline prorated charge (no redirect ever again). */
export async function createSeatCheckoutSession(input: {
  organizationId: string;
  quantity: number;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string }> {
  const priceId = getSettings().stripeSeatPriceId;
  if (!priceId) {
    throw new StripeApiError(503, "STRIPE_SEAT_PRICE_ID not configured");
  }
  const session = await stripeRequest<{ url?: string }>("/checkout/sessions", {
    mode: "subscription",
    line_items: [{ price: priceId, quantity: input.quantity }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    // orgId on BOTH the session (checkout.session.completed) and the
    // subscription (defense in depth for subscription-keyed lookups).
    metadata: { orgId: input.organizationId },
    subscription_data: { metadata: { orgId: input.organizationId } },
  });
  if (!session.url) throw new StripeApiError(500, "checkout session lacks url");
  return { url: session.url };
}

interface StripeSubscription {
  id: string;
  items: { data: Array<{ id: string; quantity?: number }> };
}

async function getSubscriptionItem(
  subscriptionId: string,
): Promise<{ itemId: string }> {
  const key = getSettings().stripeSecretKey;
  if (!key) throw new StripeApiError(503, "STRIPE_SECRET_KEY not configured");
  const res = await fetch(`${BASE_URL}/subscriptions/${subscriptionId}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const body = (await res.json().catch(() => ({}))) as StripeSubscription &
    Record<string, unknown>;
  if (!res.ok) throw new StripeApiError(res.status, "subscription not found");
  const itemId = body.items?.data?.[0]?.id;
  if (!itemId) throw new StripeApiError(500, "subscription has no items");
  return { itemId };
}

/** The inline recompute behind the Apply button: what the org pays NOW for
 *  moving this cycle to `quantity` seats (negative = credit). */
export async function previewSeatChange(input: {
  subscriptionId: string;
  quantity: number;
}): Promise<{ amountDueCents: number; currency: string }> {
  const { itemId } = await getSubscriptionItem(input.subscriptionId);
  const preview = await stripeRequest<{
    amount_due?: number;
    currency?: string;
  }>("/invoices/create_preview", {
    subscription: input.subscriptionId,
    subscription_details: {
      items: [{ id: itemId, quantity: input.quantity }],
      proration_behavior: "always_invoice",
    },
  });
  return {
    amountDueCents: preview.amount_due ?? 0,
    currency: preview.currency ?? "usd",
  };
}

/** Commit the seat change on Stripe: prorated difference charged immediately
 *  on the saved card (always_invoice); pending_if_incomplete keeps the
 *  subscription consistent if the bank demands 3DS. */
export async function applySeatQuantity(input: {
  subscriptionId: string;
  quantity: number;
}): Promise<void> {
  const { itemId } = await getSubscriptionItem(input.subscriptionId);
  await stripeRequest(`/subscriptions/${input.subscriptionId}`, {
    items: [{ id: itemId, quantity: input.quantity }],
    proration_behavior: "always_invoice",
    payment_behavior: "pending_if_incomplete",
  });
}
