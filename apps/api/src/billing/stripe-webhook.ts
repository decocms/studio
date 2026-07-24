/**
 * Stripe webhook intake for per-seat self-serve billing. The checkout
 * creator that sets metadata.orgId is ORGANIZATION_BILLING_CHECKOUT_START
 * (tools/organization/billing-checkout.ts); the customer portal (cancel /
 * card update) is still future work. On deployments without
 * STRIPE_WEBHOOK_SECRET this module is dormant.
 *
 * The webhook is the SOURCE OF TRUTH writer for organization_billing's
 * subscription state. Stripe guarantees neither delivery order nor
 * exactly-once, so safety comes from two rules rather than trust:
 *  - `last_stripe_event_at` high-water mark: an event whose `created` is
 *    older than the newest applied one is skipped (same-second ties apply
 *    last-write-wins — the accepted 1s ceiling).
 *  - customer.subscription.deleted is EXEMPT from the mark (terminal in
 *    Stripe — a deleted subscription never comes back) and UNBINDS
 *    stripe_subscription_id, so late events for a dead subscription resolve
 *    to nothing and a re-subscribe binds a fresh subscription cleanly.
 * Benefit grants are additionally deduped at the gateway by deterministic
 * referenceIds, and state + grant intent commit in one row update.
 *
 * Events:
 *  - checkout.session.completed / ...async_payment_succeeded → bind
 *    customer/subscription to the org (metadata.orgId, set by our checkout
 *    creator) once payment_status is "paid"; status active, grant. Refuses
 *    legacy / non-self-serve orgs and rebinding over a live different
 *    subscription (the refused-but-paid orphan subscription is canceled).
 *  - customer.subscription.updated → mirror status + current period end.
 *  - customer.subscription.deleted → status canceled + unbind; grant
 *    recomputes to 0 (the sync workflow zeroes self_serve orgs whose
 *    subscription isn't good).
 *  - invoice.paid → THE MONTHLY CLOCK: refresh period end + re-grant with
 *    referenceId = invoice id, which is what makes the gateway allowance
 *    reset per billing cycle (no cron anywhere).
 *
 * Payment-success events (checkout completion, invoice.paid) additionally
 * RECONCILE the subscription quantity onto the paid-seat rows — the
 * self-healing loop for a SEATS_SET whose Stripe mirror failed or whose
 * pending_if_incomplete update expired. Success anchors only: reconciling on
 * failure events would loop charge attempts on a failing card.
 *
 * Payload compat: API version 2025-03-31 (Basil) moved invoice.subscription
 * under invoice.parent.subscription_details and the subscription's
 * current_period_end onto items.data[] — handlers read both shapes.
 *
 * Signature: Stripe's v1 scheme (HMAC-SHA256 over `${t}.${rawBody}`),
 * timing-safe, ±5 min timestamp tolerance (replay window), any v1 entry may
 * match (secret rotation sends one per active secret). Hand-rolled on
 * purpose — the Stripe SDK isn't a dependency anywhere in this repo.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { getDb } from "@/database";
import {
  OrganizationBillingStorage,
  type OrganizationBillingRow,
} from "../storage/organization-billing";
import {
  cancelSubscription,
  reconcileSeatQuantity,
  StripeApiError,
} from "./stripe-api";
import { creditGatewayTopUp } from "./gateway-admin";
import { hasChargeableSubscription } from "./subscription-state";
import { enqueueBenefitsSync } from "./sync-org-benefits";

const SIGNATURE_TOLERANCE_SEC = 300;

export function verifyStripeSignature(
  rawBody: string,
  sigHeader: string | null | undefined,
  secret: string | undefined,
  nowMs = Date.now(),
): boolean {
  if (!sigHeader || !secret) return false;
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const kv of sigHeader.split(",")) {
    const i = kv.indexOf("=");
    if (i <= 0) continue;
    const key = kv.slice(0, i).trim();
    const value = kv.slice(i + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1") signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return false;
  // Stale timestamps are rejected outright: a captured (body, signature)
  // pair must not be a permanent replay capability.
  const t = Number(timestamp);
  if (
    !Number.isFinite(t) ||
    Math.abs(nowMs / 1000 - t) > SIGNATURE_TOLERANCE_SEC
  ) {
    return false;
  }
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const a = Buffer.from(expected, "hex");
  return signatures.some((sig) => {
    const b = Buffer.from(sig, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/** The slice of a Stripe event the handlers consume. */
export interface StripeEvent {
  id?: string;
  type: string;
  /** Event creation time (epoch seconds) — feeds the high-water mark. */
  created?: number;
  livemode?: boolean;
  data: { object: Record<string, unknown> };
}

/** Structural gate over a verified raw body: null = not a Stripe event. */
export function parseStripeEvent(rawBody: string): StripeEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const event = rec(parsed);
  const object = rec(rec(event?.data)?.object);
  if (!event || typeof event.type !== "string" || !object) return null;
  return {
    id: s(event.id),
    type: event.type,
    created: typeof event.created === "number" ? event.created : undefined,
    livemode: typeof event.livemode === "boolean" ? event.livemode : undefined,
    data: { object },
  };
}

/** Map Stripe subscription statuses onto our billing.status vocabulary. */
export function mapSubscriptionStatus(stripeStatus: unknown): string {
  switch (stripeStatus) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
      return "past_due";
    default:
      // canceled, unpaid, incomplete_expired, paused… — no service. A later
      // legitimate recovery (unpaid invoice settled, pause resumed) arrives
      // as a fresh subscription.updated and passes the high-water mark.
      return "canceled";
  }
}

function s(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : undefined;
}

function epochToDate(v: unknown): Date | null {
  return typeof v === "number" ? new Date(v * 1000) : null;
}

/** Id-or-expanded-object fields (customer, subscription). */
function idOf(v: unknown): string | undefined {
  return s(v) ?? s(rec(v)?.id);
}

/** invoice → subscription id; Basil moved it under invoice.parent. */
function invoiceSubscriptionId(
  obj: Record<string, unknown>,
): string | undefined {
  return (
    idOf(obj.subscription) ??
    s(rec(rec(obj.parent)?.subscription_details)?.subscription)
  );
}

/** subscription → current period end; Basil moved it onto items.data[]. */
function subscriptionPeriodEnd(obj: Record<string, unknown>): Date | null {
  const direct = epochToDate(obj.current_period_end);
  if (direct) return direct;
  const items = rec(obj.items)?.data;
  if (!Array.isArray(items)) return null;
  let max = 0;
  for (const item of items) {
    const end = rec(item)?.current_period_end;
    if (typeof end === "number" && end > max) max = end;
  }
  return max > 0 ? new Date(max * 1000) : null;
}

function isStale(event: StripeEvent, billing: OrganizationBillingRow): boolean {
  const created = epochToDate(event.created);
  return (
    !!created &&
    !!billing.lastStripeEventAt &&
    created < billing.lastStripeEventAt
  );
}

/** Forward-only mark: never regress it (deleted applies out of order). */
function nextWatermark(
  event: StripeEvent,
  billing: OrganizationBillingRow,
): Date | undefined {
  const created = epochToDate(event.created);
  if (!created) return undefined;
  return billing.lastStripeEventAt && billing.lastStripeEventAt > created
    ? undefined
    : created;
}

export type HandledStripeEvent =
  | {
      handled: false;
      reason: string;
      /** A LIVE subscription the customer paid for that we refused to bind
       *  (rebind guard) — the route wrapper cancels it so nothing keeps
       *  charging a card that bought no service. */
      orphanSubscriptionId?: string;
    }
  | {
      handled: true;
      organizationId: string;
      benefitsReferenceId?: string;
      /** A paid AI-credit top-up to forward to the gateway (route wrapper
       *  credits it; a failure THROWS so Stripe redelivers — Stripe is the
       *  retry queue, the gateway referenceId dedupe makes replays no-ops). */
      topUp?: { creditCents: number; referenceId: string };
    };

/**
 * Apply one Stripe event to billing state. Pure-ish over the storage: returns
 * what changed so the route can enqueue the benefit delivery AFTER the write
 * committed. Unknown org / unknown event types / stale deliveries are
 * acknowledged no-ops — Stripe must get its 200 either way, redelivery
 * wouldn't help.
 */
export async function applyStripeEvent(
  storage: OrganizationBillingStorage,
  event: StripeEvent,
): Promise<HandledStripeEvent> {
  const obj = event.data.object;

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const organizationId = s(rec(obj.metadata)?.orgId);
      if (!organizationId) return { handled: false, reason: "no orgId" };

      // AI-credit top-up (mode=payment, metadata.kind=topup — set by our own
      // checkout creator). Orthogonal to seats: NO billing-row writes, no
      // watermark, and deliberately allowed for legacy orgs (credits always
      // were). The gateway credit happens in the route wrapper.
      if (s(rec(obj.metadata)?.kind) === "topup") {
        if (obj.mode !== "payment") {
          return { handled: false, reason: "topup with wrong mode" };
        }
        if (s(obj.payment_status) !== "paid") {
          return { handled: false, reason: "payment not confirmed" };
        }
        const creditCents = Number(rec(obj.metadata)?.creditCents);
        if (!Number.isInteger(creditCents) || creditCents <= 0) {
          return { handled: false, reason: "bad topup metadata" };
        }
        return {
          handled: true,
          organizationId,
          topUp: {
            creditCents,
            referenceId: `stripe-topup:${s(obj.id) ?? crypto.randomUUID()}`,
          },
        };
      }

      if (obj.mode !== "subscription") {
        return { handled: false, reason: "not a subscription checkout" };
      }
      // Delayed-notification methods fire checkout.session.completed while
      // payment_status is still "unpaid" — service starts when the payment
      // confirms (async_payment_succeeded re-enters here with "paid").
      if (s(obj.payment_status) !== "paid") {
        return { handled: false, reason: "payment not confirmed" };
      }
      const billing = await storage.getBilling(organizationId);
      if (!billing) return { handled: false, reason: "unknown org" };
      // metadata.orgId comes from our checkout creator, but never let it
      // rebind billing it must not touch: self-serve, non-legacy orgs only,
      // and never an org still bound to a DIFFERENT subscription (deleted
      // unbinds, so a legitimate re-subscribe passes).
      if (billing.legacy || billing.billingMode !== "self_serve") {
        console.error("stripe webhook: refused checkout bind", {
          organizationId,
          eventId: event.id,
          legacy: billing.legacy,
          billingMode: billing.billingMode,
        });
        return { handled: false, reason: "org is not self-serve" };
      }
      const subscriptionId = idOf(obj.subscription);
      if (
        billing.stripeSubscriptionId &&
        subscriptionId &&
        billing.stripeSubscriptionId !== subscriptionId
      ) {
        console.error("stripe webhook: refused checkout rebind", {
          organizationId,
          eventId: event.id,
        });
        return {
          handled: false,
          reason: "org already bound to another subscription",
          orphanSubscriptionId: subscriptionId,
        };
      }
      if (isStale(event, billing)) {
        return { handled: false, reason: "stale event" };
      }
      const referenceId = `stripe-checkout:${s(obj.id) ?? crypto.randomUUID()}`;
      await storage.updateStripeState(organizationId, {
        stripeCustomerId: idOf(obj.customer),
        stripeSubscriptionId: subscriptionId,
        status: "active",
        benefitsReferenceId: referenceId,
        lastStripeEventAt: nextWatermark(event, billing),
      });
      return {
        handled: true,
        organizationId,
        benefitsReferenceId: referenceId,
      };
    }

    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscriptionId = s(obj.id);
      if (!subscriptionId) return { handled: false, reason: "no sub id" };
      const billing =
        await storage.getBillingByStripeSubscriptionId(subscriptionId);
      if (!billing) return { handled: false, reason: "unknown subscription" };
      const isDeleted = event.type === "customer.subscription.deleted";
      // deleted is terminal — always safe to apply, even delivered late.
      if (!isDeleted && isStale(event, billing)) {
        return { handled: false, reason: "stale event" };
      }
      const status = isDeleted ? "canceled" : mapSubscriptionStatus(obj.status);
      const periodEnd = subscriptionPeriodEnd(obj);
      // Status changes move the effective grant (canceled → 0) — re-deliver.
      // Deterministic per (sub, status, period) so redeliveries collapse.
      const referenceId = `stripe-sub:${subscriptionId}:${status}:${
        periodEnd?.getTime() ?? 0
      }`;
      await storage.updateStripeState(billing.organizationId, {
        status,
        currentPeriodEnd: periodEnd,
        ...(isDeleted && { stripeSubscriptionId: null }),
        benefitsReferenceId: referenceId,
        lastStripeEventAt: nextWatermark(event, billing),
      });
      return {
        handled: true,
        organizationId: billing.organizationId,
        benefitsReferenceId: referenceId,
      };
    }

    case "invoice.paid": {
      const subscriptionId = invoiceSubscriptionId(obj);
      if (!subscriptionId) return { handled: false, reason: "no sub id" };
      const billing =
        await storage.getBillingByStripeSubscriptionId(subscriptionId);
      if (!billing) return { handled: false, reason: "unknown subscription" };
      if (isStale(event, billing)) {
        return { handled: false, reason: "stale event" };
      }
      // THE monthly reset: deterministic reference (invoice id) so Stripe
      // redeliveries collapse into one gateway rebase per cycle. Setting
      // active here is also the unpaid→paid recovery path; a truly deleted
      // subscription can't reach this (deleted unbinds the id).
      const referenceId = `stripe-invoice:${s(obj.id) ?? crypto.randomUUID()}`;
      await storage.updateStripeState(billing.organizationId, {
        status: "active",
        currentPeriodEnd: epochToDate(obj.period_end),
        benefitsReferenceId: referenceId,
        lastStripeEventAt: nextWatermark(event, billing),
      });
      return {
        handled: true,
        organizationId: billing.organizationId,
        benefitsReferenceId: referenceId,
      };
    }

    default:
      return { handled: false, reason: `unhandled event ${event.type}` };
  }
}

/** Events that prove the customer's card WORKS — the only anchors we let
 *  trigger a quantity reconciliation (re-applying a quantity can charge; a
 *  failure-path anchor would loop charge attempts on a failing card). */
const RECONCILE_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "invoice.paid",
]);

/**
 * Converge Stripe's subscription quantity onto the org's seat rows. This is
 * the self-healing half of the SEATS_SET mirror: rows commit before the
 * Stripe call there, so a failed/pending proration (declined card, expired
 * pending_update, pod death mid-request) leaves quantity < rows — every paid
 * invoice re-converges it, monthly at worst. Fail-soft: a miss is retried by
 * the next cycle's event.
 */
async function reconcileQuantityWithRows(
  storage: OrganizationBillingStorage,
  organizationId: string,
): Promise<void> {
  const [billing, paidSeatUserIds] = await Promise.all([
    storage.getBilling(organizationId),
    storage.listPaidSeatUserIds(organizationId),
  ]);
  if (!hasChargeableSubscription(billing)) return;
  const corrected = await reconcileSeatQuantity({
    subscriptionId: billing.stripeSubscriptionId,
    targetQuantity: paidSeatUserIds.length,
  });
  if (corrected) {
    console.error("stripe webhook: reconciled diverged seat quantity", {
      organizationId,
      targetQuantity: paidSeatUserIds.length,
    });
  }
}

/** Route-facing wrapper: apply + durable benefit delivery (fail-soft — the
 *  pending marker is committed, the scheduled sweep covers a lost enqueue). */
export async function processStripeEvent(
  event: StripeEvent,
): Promise<HandledStripeEvent> {
  const storage = new OrganizationBillingStorage(getDb().db);
  const result = await applyStripeEvent(storage, event);
  // Top-up: forward the paid credits to the gateway. NOT fail-soft — a throw
  // 500s the route so Stripe redelivers, and the gateway referenceId dedupe
  // makes every replay a no-op. Stripe is the retry queue here.
  if (result.handled && result.topUp) {
    await creditGatewayTopUp({
      organizationId: result.organizationId,
      amountCents: result.topUp.creditCents,
      referenceId: result.topUp.referenceId,
    });
  }
  if (result.handled && result.benefitsReferenceId) {
    try {
      await enqueueBenefitsSync(
        result.organizationId,
        result.benefitsReferenceId,
        "apply",
      );
    } catch (err) {
      console.error("Failed to enqueue benefit sync (sweep covers):", err);
    }
  }
  if (result.handled && RECONCILE_EVENT_TYPES.has(event.type)) {
    try {
      await reconcileQuantityWithRows(storage, result.organizationId);
    } catch (err) {
      console.error("Failed to reconcile seat quantity (next cycle):", err);
    }
  }
  // The customer PAID for this subscription and the org refused it — cancel
  // so it stops charging. NOT fail-soft: the route 200-acks refusals (no
  // Stripe redelivery), so a transient cancel failure must escape to the
  // route's 500 to make Stripe redeliver this refusal and retry the cancel.
  // Already-gone (400 canceled / 404 missing) is success.
  if (!result.handled && result.orphanSubscriptionId) {
    try {
      await cancelSubscription(result.orphanSubscriptionId);
      console.error("stripe webhook: canceled orphan subscription", {
        subscriptionId: result.orphanSubscriptionId,
        eventId: event.id,
      });
    } catch (err) {
      const alreadyGone =
        err instanceof StripeApiError &&
        (err.status === 400 || err.status === 404);
      if (!alreadyGone) throw err;
    }
  }
  return result;
}
