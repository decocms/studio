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

const REQUEST_TIMEOUT_MS = 15_000;

async function stripeRequest<T>(
  path: string,
  init?: {
    method?: "GET" | "POST" | "DELETE";
    params?: Record<string, unknown>;
  },
): Promise<T> {
  const key = getSettings().stripeSecretKey;
  // Config-missing messages are deliberately generic: they surface to org
  // admins through tool errors — actionable, without echoing env var names.
  if (!key) throw new StripeApiError(503, "billing is not configured");
  const body = init?.params ? toStripeForm(init.params).toString() : undefined;
  const res = await fetch(`${BASE_URL}${path}`, {
    method: init?.method ?? (body ? "POST" : "GET"),
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body && { "Content-Type": "application/x-www-form-urlencoded" }),
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const parsed = (await res.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!res.ok) {
    const message =
      ((parsed.error as Record<string, unknown> | undefined)?.message as
        | string
        | undefined) ?? `HTTP ${res.status}`;
    throw new StripeApiError(res.status, message);
  }
  return parsed as T;
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
    throw new StripeApiError(503, "billing is not configured");
  }
  const session = await stripeRequest<{ url?: string }>("/checkout/sessions", {
    params: {
      mode: "subscription",
      line_items: [{ price: priceId, quantity: input.quantity }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      // orgId on BOTH the session (checkout.session.completed) and the
      // subscription (defense in depth for subscription-keyed lookups).
      metadata: { orgId: input.organizationId },
      subscription_data: { metadata: { orgId: input.organizationId } },
    },
  });
  if (!session.url) throw new StripeApiError(500, "checkout session lacks url");
  return { url: session.url };
}

interface StripeSubscription {
  id: string;
  items: {
    data: Array<{ id: string; quantity?: number; price?: { id?: string } }>;
  };
}

/**
 * The org's SEAT item on its subscription: matched by the configured seat
 * price so a dashboard-added second item (a future addon) can never get its
 * quantity silently rewritten by a seat change. Falls back to a sole item
 * only when no price is configured.
 */
async function getSeatItem(
  subscriptionId: string,
): Promise<{ itemId: string; quantity: number }> {
  const sub = await stripeRequest<StripeSubscription>(
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
  );
  const items = sub.items?.data ?? [];
  const priceId = getSettings().stripeSeatPriceId;
  const item = priceId
    ? items.find((i) => i.price?.id === priceId)
    : items.length === 1
      ? items[0]
      : undefined;
  if (!item) throw new StripeApiError(500, "subscription has no seat item");
  return { itemId: item.id, quantity: item.quantity ?? 0 };
}

/** The inline recompute behind the Apply button: what the org pays NOW for
 *  moving this cycle to `quantity` seats (negative = credit). */
export async function previewSeatChange(input: {
  subscriptionId: string;
  quantity: number;
}): Promise<{ amountDueCents: number; currency: string }> {
  const { itemId } = await getSeatItem(input.subscriptionId);
  const preview = await stripeRequest<{
    amount_due?: number;
    currency?: string;
  }>("/invoices/create_preview", {
    params: {
      subscription: input.subscriptionId,
      subscription_details: {
        items: [{ id: itemId, quantity: input.quantity }],
        proration_behavior: "always_invoice",
      },
    },
  });
  return {
    amountDueCents: preview.amount_due ?? 0,
    currency: preview.currency ?? "usd",
  };
}

/** Self-serve management surface (card, invoices, cancellation) — Stripe's
 *  hosted Customer Portal; we never build billing UI for what Stripe hosts. */
export async function createBillingPortalSession(input: {
  customerId: string;
  returnUrl: string;
}): Promise<{ url: string }> {
  const session = await stripeRequest<{ url?: string }>(
    "/billing_portal/sessions",
    { params: { customer: input.customerId, return_url: input.returnUrl } },
  );
  if (!session.url) throw new StripeApiError(500, "portal session lacks url");
  return { url: session.url };
}

/** Commit the seat change on Stripe: prorated difference charged immediately
 *  on the saved card (always_invoice); pending_if_incomplete keeps the
 *  subscription consistent if the bank demands 3DS. */
export async function applySeatQuantity(input: {
  subscriptionId: string;
  quantity: number;
}): Promise<void> {
  const { itemId } = await getSeatItem(input.subscriptionId);
  await stripeRequest(
    `/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
    {
      params: {
        items: [{ id: itemId, quantity: input.quantity }],
        proration_behavior: "always_invoice",
        payment_behavior: "pending_if_incomplete",
      },
    },
  );
}

/** Cancel a subscription outright. Used for orphans: a checkout that
 *  completed for an org already bound to a different subscription — the
 *  customer paid, the webhook refused the bind, nothing should keep billing. */
export async function cancelSubscription(
  subscriptionId: string,
): Promise<void> {
  await stripeRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: "DELETE",
  });
}

/**
 * Converge the subscription quantity onto the seat rows (the truth of WHO is
 * paid-for). Called from webhook anchors that prove the card WORKS
 * (invoice.paid, checkout completion) — never from failure paths, so a
 * declined proration can't loop charge attempts. No-op when they already
 * match. Returns whether a correction was pushed.
 */
export async function reconcileSeatQuantity(input: {
  subscriptionId: string;
  targetQuantity: number;
}): Promise<boolean> {
  if (input.targetQuantity < 1) return false; // zero-seat = cancellation flow, not a quantity
  const { itemId, quantity } = await getSeatItem(input.subscriptionId);
  if (quantity === input.targetQuantity) return false;
  await stripeRequest(
    `/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
    {
      params: {
        items: [{ id: itemId, quantity: input.targetQuantity }],
        proration_behavior: "always_invoice",
        payment_behavior: "pending_if_incomplete",
      },
    },
  );
  return true;
}
