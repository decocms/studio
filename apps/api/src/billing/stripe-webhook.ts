/**
 * Stripe webhook intake — the SOURCE OF TRUTH writer for organization_billing
 * subscription state. Dormant without STRIPE_WEBHOOK_SECRET.
 *
 * Stripe guarantees neither order nor exactly-once; two rules make that safe:
 *  - `last_stripe_event_at` high-water mark: older deliveries are skipped.
 *  - subscription.deleted is terminal: exempt from the mark and UNBINDS the
 *    subscription id, so late events for it resolve to nothing.
 *
 * Events: checkout completion binds customer/subscription once paid (a
 * rebind over a live different subscription is refused and the orphan
 * canceled); subscription.updated mirrors status + period end; deleted
 * cancels + unbinds; invoice.paid is THE MONTHLY CLOCK (period refresh,
 * unpaid→paid recovery, and the future quota-reset anchor — no cron).
 *
 * Handlers read both pre- and post-Basil (2025-03-31) payload shapes.
 * Signature: Stripe v1 (HMAC-SHA256, timing-safe, ±5 min tolerance, any v1
 * entry may match for secret rotation).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { getDb } from "@/database";
import {
  OrganizationBillingStorage,
  type OrganizationBillingRow,
} from "../storage/organization-billing";
import { cancelSubscription, StripeApiError } from "./stripe-api";

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
      /** Paid-for subscription we refused to bind — the route wrapper
       *  cancels it so it stops charging. */
      orphanSubscriptionId?: string;
    }
  | {
      handled: true;
      organizationId: string;
    };

/**
 * Apply one Stripe event to billing state. Pure-ish over the storage.
 * Unknown org / unknown event types / stale deliveries are acknowledged
 * no-ops — Stripe must get its 200 either way, redelivery wouldn't help.
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
      // Never rebind over a DIFFERENT live subscription (deleted unbinds,
      // so a legitimate re-subscribe passes).
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
      await storage.updateStripeState(organizationId, {
        stripeCustomerId: idOf(obj.customer),
        stripeSubscriptionId: subscriptionId,
        status: "active",
        lastStripeEventAt: nextWatermark(event, billing),
      });
      return { handled: true, organizationId };
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
      await storage.updateStripeState(billing.organizationId, {
        status,
        currentPeriodEnd: subscriptionPeriodEnd(obj),
        ...(isDeleted && { stripeSubscriptionId: null }),
        lastStripeEventAt: nextWatermark(event, billing),
      });
      return { handled: true, organizationId: billing.organizationId };
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
      // THE monthly clock: refresh period end; active here is also the
      // unpaid→paid recovery (a deleted subscription can't reach this).
      await storage.updateStripeState(billing.organizationId, {
        status: "active",
        currentPeriodEnd: epochToDate(obj.period_end),
        lastStripeEventAt: nextWatermark(event, billing),
      });
      return { handled: true, organizationId: billing.organizationId };
    }

    default:
      return { handled: false, reason: `unhandled event ${event.type}` };
  }
}

/** Route-facing wrapper: apply, then clean up refused-but-paid orphans. */
export async function processStripeEvent(
  event: StripeEvent,
): Promise<HandledStripeEvent> {
  const storage = new OrganizationBillingStorage(getDb().db);
  const result = await applyStripeEvent(storage, event);
  // Cancel a refused-but-paid subscription so it stops charging. NOT
  // fail-soft: a transient failure must 500 the route so Stripe redelivers
  // and the cancel retries. Already-gone (400/404) is success.
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
