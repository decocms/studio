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
    /** Stripe replays the FIRST response for a repeated key instead of acting
     *  twice. Required on anything that moves money from a handler Stripe may
     *  redeliver — a refund without one is a second refund. */
    idempotencyKey?: string;
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
      ...(init?.idempotencyKey && {
        "Idempotency-Key": init.idempotencyKey,
      }),
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

/** Custom-field key carrying the buyer's CPF/CNPJ. Stripe requires the key to
 *  be alphanumeric, hence no separator. */
const TAX_ID_FIELD_KEY = "taxid";

/** A bare CPF is the shortest accepted value (11 digits), a formatted CNPJ the
 *  longest (`00.000.000/0000-00`). */
const TAX_ID_MIN_LENGTH = 11;
const TAX_ID_MAX_LENGTH = 18;

/**
 * Collect the buyer's billing address + CPF/CNPJ on every Checkout — both are
 * API-only params with no Dashboard fallback, so omitting them means we never
 * see either.
 *
 * The tax ID rides a required `custom_fields` entry rather than
 * `tax_id_collection`, because Brazil is absent from Checkout's supported
 * billing countries: `br_cnpj`/`br_cpf` exist on the Customer Tax ID API but
 * not in Checkout, so `tax_id_collection[required]=if_supported` resolves to
 * "not supported, therefore not required" for a BR buyer and the field never
 * renders. The submitted value lands on `session.custom_fields[].text.value`,
 * on `checkout.session.completed`, and in the Dashboard payment export.
 *
 * Required unconditionally: Checkout can't vary a custom field by country, and
 * `adaptive_pricing` means a USD session doesn't imply a foreign buyer — every
 * completed session on this account bills to a BR address, USD ones included.
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
    custom_fields: [
      {
        key: TAX_ID_FIELD_KEY,
        label: { type: "custom", custom: "CPF / CNPJ" },
        type: "text",
        optional: false,
        text: {
          minimum_length: TAX_ID_MIN_LENGTH,
          maximum_length: TAX_ID_MAX_LENGTH,
        },
      },
    ],
    ...(customerId && { customer_update: { address: "auto", name: "auto" } }),
  };
}

/**
 * The Stripe Price that sells `planId`, or undefined when the operator has not
 * priced it.
 *
 * `STRIPE_PLAN_PRICE_IDS` is keyed price → plan (a price grants exactly one
 * tier; a tier may be sold by more than one price), so buying reads it
 * backwards. Undefined is the answer that matters: a plan with no price cannot
 * be sold, and refusing here is what stops a tier being handed out for a
 * payment that was never taken.
 *
 * `?? {}` because a partially-mocked settings object is a crash here
 * otherwise, and "no prices configured" is the safe reading of a missing map.
 */
/** Is this price one the operator mapped to a plan — i.e. a plan line rather
 *  than an add-on sitting beside it on the same subscription. */
export function isPlanPrice(priceId: string): boolean {
  return Boolean((getSettings().stripePlanPriceIds ?? {})[priceId]);
}

export function priceIdForPlan(planId: string): string | undefined {
  const map = getSettings().stripePlanPriceIds ?? {};
  return Object.entries(map).find(([, id]) => id === planId)?.[0];
}

/** First subscribe: Checkout collects + saves the card for the org's flat
 *  monthly subscription (quantity 1). */
/**
 * The key that makes two clicks one checkout.
 *
 * Stripe replays the first response for a repeated idempotency key, so every
 * concurrent attempt for the same org and plan receives the SAME Checkout
 * Session — and a Session can only be completed once. That is what stops a
 * double-click, a second tab, or an impatient retry from becoming two paid
 * subscriptions. Refunding one afterwards is not equivalent: Stripe keeps its
 * processing fee on a refund, so a cured double charge still costs real money,
 * and the customer still saw two charges.
 *
 * Salted with the billing row's last Stripe event so the key changes when the
 * org's situation does. Without the salt an org that subscribed, cancelled, and
 * came back inside Stripe's 24h key window would be handed its old, already
 * completed session and could not subscribe again. Concurrent clicks read the
 * same watermark, so they still collapse to one session.
 */
export function checkoutIdempotencyKey(input: {
  organizationId: string;
  planId?: string;
  lastStripeEventAt?: Date | null;
}): string {
  return [
    "checkout",
    input.organizationId,
    input.planId ?? "flat",
    input.lastStripeEventAt?.getTime() ?? 0,
  ].join(":");
}

export async function createOrgCheckoutSession(input: {
  organizationId: string;
  successUrl: string;
  cancelUrl: string;
  /** Watermark from the org's billing row; salts the idempotency key. */
  lastStripeEventAt?: Date | null;
  /** The gateway plan being bought. Its price comes from the plan price map,
   *  and it rides the session metadata so the webhook can grant the tier on
   *  completion. Omitted → the flat STRIPE_ORG_PRICE_ID and no tier. */
  planId?: string;
}): Promise<{ url: string }> {
  const settings = getSettings();
  // The plan's own price, or the flat subscription price for a deployment
  // with no tiers configured. A plan the operator has not priced cannot be
  // sold — refusing here is what stops a tier being handed out for a payment
  // that was never taken.
  const priceId = input.planId
    ? priceIdForPlan(input.planId)
    : settings.stripeOrgPriceId;
  if (!priceId) {
    throw new StripeApiError(
      503,
      input.planId
        ? `plan '${input.planId}' has no Stripe price configured`
        : "billing is not configured",
    );
  }
  const session = await stripeRequest<{ url?: string }>("/checkout/sessions", {
    // Two clicks, one session — see checkoutIdempotencyKey.
    idempotencyKey: checkoutIdempotencyKey({
      organizationId: input.organizationId,
      ...(input.planId ? { planId: input.planId } : {}),
      ...(input.lastStripeEventAt !== undefined && {
        lastStripeEventAt: input.lastStripeEventAt,
      }),
    }),
    params: {
      mode: "subscription",
      // No `customer` is passed here — Checkout creates one, so no write-back.
      ...taxAndAddressParams(null),
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      // orgId on BOTH the session (checkout.session.completed) and the
      // subscription (defense in depth for subscription-keyed lookups).
      metadata: {
        orgId: input.organizationId,
        ...(input.planId ? { planId: input.planId } : {}),
      },
      subscription_data: {
        /**
         * Bill on the 1st, UTC midnight — the day the gateway resets every
         * org's allowance (`currentPeriod` in plans-shape.ts). Without this
         * Stripe anchors to the signup day, so an org subscribing on the 20th
         * pays a full month and gets eleven days of allowance before the reset.
         * Stripe's default proration then charges the partial first month pro
         * rata rather than giving it away or billing it whole.
         *
         * Declarative rather than an absolute `billing_cycle_anchor` timestamp,
         * and that is a correctness difference, not a style one: a Checkout
         * Session lives 24h, but Stripe validates an absolute anchor when the
         * subscription is CREATED — when the buyer clicks pay. A session opened
         * at 23:50 UTC on the 31st and paid at 00:02 carries an anchor that is
         * now in the past, and Stripe refuses the subscription outright. For a
         * BR customer base that window is 21:00 BRT on the last day of the
         * month, i.e. peak evening, every month. A day-of-month config cannot
         * go stale. Verified to produce exactly 2026-10-01T00:00:00Z.
         *
         * ponytail: monthly prices only — a yearly tier would need its own
         * anchoring story.
         */
        billing_cycle_anchor_config: {
          day_of_month: 1,
          hour: 0,
          minute: 0,
          second: 0,
        },
        metadata: {
          orgId: input.organizationId,
          ...(input.planId ? { planId: input.planId } : {}),
        },
      },
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
  /** `data[].id` is the subscription ITEM id, which is what a price swap
   *  addresses — the subscription id alone cannot say which line to change. */
  items?: {
    data?: {
      id?: string;
      current_period_end?: number;
      price?: { id?: string };
    }[];
  };
}

/**
 * Move an EXISTING subscription to another tier, on Stripe's hosted
 * confirmation screen.
 *
 * Checkout cannot do this: a second checkout for an org that already has a
 * subscription is a second subscription, which is a double charge — so
 * `ORGANIZATION_BILLING_CHECKOUT_START` refuses it and, before this, Pro → Ultra
 * had no route at all. The portal's `subscription_update_confirm` flow drops
 * the buyer straight onto the confirm step for one specific price, showing the
 * proration before anything is charged. We never render that amount ourselves;
 * quoting a proration we computed and charging one Stripe computed is how the
 * two drift.
 *
 * On confirm Stripe swaps the item and fires `customer.subscription.updated`,
 * which the webhook already resolves back to a tier through the price map — so
 * the entitlement follows the money without a second code path.
 *
 * Runs on its OWN portal configuration (`STRIPE_PORTAL_CONFIGURATION_ID`), not
 * the account default: the default also backs the full self-serve portal, and
 * listing the tier products there would let anyone switch plans freely. That
 * configuration must list every purchasable plan's product — Stripe 400s
 * otherwise, and its message is what the org admin sees. Verified: with the
 * default configuration, Stripe refuses with "the configuration does not
 * include the price in its features[subscription_update][products]".
 */
export async function createSubscriptionUpdateSession(input: {
  customerId: string;
  subscriptionId: string;
  subscriptionItemId: string;
  priceId: string;
  returnUrl: string;
}): Promise<{ url: string }> {
  const session = await stripeRequest<{ url?: string }>(
    "/billing_portal/sessions",
    {
      params: {
        customer: input.customerId,
        return_url: input.returnUrl,
        ...(getSettings().stripePortalConfigurationId && {
          configuration: getSettings().stripePortalConfigurationId,
        }),
        flow_data: {
          type: "subscription_update_confirm",
          subscription_update_confirm: {
            subscription: input.subscriptionId,
            items: [{ id: input.subscriptionItemId, price: input.priceId }],
          },
          after_completion: {
            type: "redirect",
            redirect: { return_url: input.returnUrl },
          },
        },
      },
    },
  );
  if (!session.url) throw new StripeApiError(500, "portal session lacks url");
  return { url: session.url };
}

export interface StripePrice {
  id: string;
  /** Minor units (centavos for BRL). Null for a price with no fixed amount. */
  unit_amount: number | null;
  /** ISO 4217, lowercase, as Stripe returns it. */
  currency: string;
  recurring?: { interval?: string } | null;
}

/** Read one Price. The amount the card is actually charged, which is the only
 *  number worth quoting — see the plan-price tool. */
export async function retrievePrice(priceId: string): Promise<StripePrice> {
  return stripeRequest<StripePrice>(`/prices/${encodeURIComponent(priceId)}`);
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

export interface StripeInvoiceRef {
  id?: string;
  amount_paid?: number;
  /** This account's API version puts these on the invoice directly. */
  payment_intent?: string | { id?: string } | null;
}

/**
 * Give back everything an orphan subscription actually took.
 *
 * Cancelling an orphan stops FUTURE billing and returns nothing, so the
 * customer who opened checkout in two tabs stayed charged twice for the one
 * subscription they kept. That is the whole double-charge: two sessions both
 * complete, the first binds, the second is refused — and refusing it is not
 * enough, because Stripe already took the money.
 *
 * Idempotent per invoice, which matters more here than anywhere else in this
 * file: this runs from a webhook Stripe redelivers on any non-2xx, and a
 * refund replayed without a key is a second refund. The key is derived from
 * the invoice, so a redelivery replays the original response instead.
 *
 * Invoices with nothing collected (a downgrade's credit note, a zero
 * proration) are skipped — there is no payment to reverse.
 */
export async function refundSubscriptionPayments(
  subscriptionId: string,
): Promise<{ refundedCents: number }> {
  const list = await stripeRequest<{ data?: StripeInvoiceRef[] }>(
    `/invoices?subscription=${encodeURIComponent(subscriptionId)}&status=paid&limit=100`,
  );
  const refunds = plannedOrphanRefunds(subscriptionId, list.data ?? []);
  for (const refund of refunds) {
    await stripeRequest("/refunds", {
      params: { payment_intent: refund.paymentIntent, reason: "duplicate" },
      idempotencyKey: refund.idempotencyKey,
    });
  }
  return {
    refundedCents: refunds.reduce((sum, r) => sum + r.amountCents, 0),
  };
}

export interface PlannedRefund {
  paymentIntent: string;
  amountCents: number;
  idempotencyKey: string;
}

/**
 * Which of an orphan's invoices actually took money, and the key that makes
 * giving it back safe to repeat.
 *
 * Split out from the HTTP so the decision is testable on its own — it is the
 * part that can be wrong in a way that costs someone money, either by missing a
 * charge (customer stays double-charged) or by refunding something that was
 * never collected.
 *
 * Skips anything with nothing collected: a downgrade's credit invoice and a
 * zero-value proration are both `paid` with `amount_paid: 0`. Skips an invoice
 * with no payment intent, which is how an invoice settled from customer balance
 * presents — there is no card payment to reverse.
 *
 * The key is per INVOICE rather than per subscription: an orphan with two paid
 * invoices must produce two distinct refunds, while a redelivery of the same
 * webhook must produce none.
 */
export function plannedOrphanRefunds(
  subscriptionId: string,
  invoices: StripeInvoiceRef[],
): PlannedRefund[] {
  const planned: PlannedRefund[] = [];
  for (const invoice of invoices) {
    const amountCents = invoice.amount_paid ?? 0;
    if (amountCents <= 0) continue;
    const paymentIntent =
      typeof invoice.payment_intent === "string"
        ? invoice.payment_intent
        : invoice.payment_intent?.id;
    if (!paymentIntent) continue;
    planned.push({
      paymentIntent,
      amountCents,
      idempotencyKey: `orphan-refund:${subscriptionId}:${invoice.id ?? paymentIntent}`,
    });
  }
  return planned;
}
