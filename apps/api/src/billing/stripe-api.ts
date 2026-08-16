/**
 * Minimal Stripe API client for the per-org subscription: Checkout, Customer
 * Portal, cancellation. Raw fetch + form encoding — no SDK dependency.
 */

import { getSettings } from "../settings";
import { getUsdToBrl, toUsdCreditCents } from "./exchange-rate";

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

/**
 * Collect the buyer's billing address + tax ID (CPF/CNPJ, VAT, …) on every
 * Checkout — both are API-only params with no Dashboard fallback, so omitting
 * them means we never see either.
 *
 * `customer_update` is mandatory, not cosmetic: with a saved `customer` and
 * address collection on, Stripe 400s the session unless we explicitly allow
 * Checkout to write back to the customer — and a customer whose address is
 * still blank would otherwise render read-only prefill the buyer can't fill.
 */
export function taxAndAddressParams(
  customerId: string | null,
): Record<string, unknown> {
  return {
    billing_address_collection: "required",
    tax_id_collection: { enabled: true },
    ...(customerId && { customer_update: { address: "auto", name: "auto" } }),
  };
}

/** First subscribe: Checkout collects + saves the card for the org's flat
 *  monthly subscription (quantity 1). */
export async function createOrgCheckoutSession(input: {
  organizationId: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string }> {
  const priceId = getSettings().stripeOrgPriceId;
  if (!priceId) {
    throw new StripeApiError(503, "billing is not configured");
  }
  const session = await stripeRequest<{ url?: string }>("/checkout/sessions", {
    params: {
      mode: "subscription",
      // No `customer` is passed here — Checkout creates one, so no write-back.
      ...taxAndAddressParams(null),
      line_items: [{ price: priceId, quantity: 1 }],
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

/**
 * AI-credit top-up (one-time payment; one Stripe customer/card for the org).
 * The buyer pays amountCents (usd or brl) + the fee; the webhook credits the
 * gateway the USD-equivalent creditCents. The FX rate is locked at session
 * creation: `metadata.creditCents` carries the converted USD amount, so the
 * webhook credits exactly what the buyer saw regardless of when it lands.
 */
export function computeTopUpChargeCents(
  amountCents: number,
  feePercent: number,
): number {
  return Math.round(amountCents * (1 + feePercent / 100));
}

export async function createTopUpCheckoutSession(input: {
  organizationId: string;
  /** Amount in the PAYMENT currency's cents (BRL centavos for brl). */
  amountCents: number;
  currency: "usd" | "brl";
  feePercent: number;
  customerId: string | null;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string }> {
  const chargeCents = computeTopUpChargeCents(
    input.amountCents,
    input.feePercent,
  );
  const creditCents = toUsdCreditCents(
    input.amountCents,
    input.currency,
    await getUsdToBrl(),
  );
  const productId = getSettings().stripeTopupProductId;
  const topupMetadata = {
    kind: "topup",
    orgId: input.organizationId,
    creditCents,
  };
  const label =
    input.currency === "brl"
      ? `Studio AI credits (R$ ${(input.amountCents / 100).toFixed(2)})`
      : `Studio AI credits ($${(input.amountCents / 100).toFixed(2)})`;
  const session = await stripeRequest<{ url?: string }>("/checkout/sessions", {
    params: {
      mode: "payment",
      // Reuse the org's saved customer when it exists (same card as the
      // subscription); otherwise Checkout creates a guest payment.
      ...(input.customerId && { customer: input.customerId }),
      ...taxAndAddressParams(input.customerId),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: input.currency,
            unit_amount: chargeCents,
            // Ad-hoc price, one fixed catalog Product — see stripeTopupProductId.
            ...(productId
              ? { product: productId }
              : { product_data: { name: label } }),
          },
        },
      ],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      // On the PaymentIntent too — the charge is what finance exports.
      metadata: topupMetadata,
      payment_intent_data: { metadata: topupMetadata },
    },
  });
  if (!session.url) throw new StripeApiError(500, "checkout session lacks url");
  return { url: session.url };
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

export interface StripeSubscription {
  id: string;
  customer: string;
  /** Unix seconds. Recent API versions moved this onto the items. */
  current_period_end?: number;
  items?: { data?: { current_period_end?: number }[] };
}

/** Read a subscription by id — used to resolve its customer and period end. */
export async function retrieveSubscription(
  subscriptionId: string,
): Promise<StripeSubscription> {
  return stripeRequest<StripeSubscription>(
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
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
