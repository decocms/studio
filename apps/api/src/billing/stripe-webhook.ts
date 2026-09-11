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
import { invalidateOrgFeaturesCache } from "@/core/plan-feature-gate";
import { getDb } from "@/database";
import { captureOrgEvent, deterministicUuid } from "@/posthog";
import {
  OrganizationBillingStorage,
  type OrganizationBillingRow,
} from "../storage/organization-billing";
import { cancelSubscription, StripeApiError } from "./stripe-api";
import { creditGatewayTopUp, setGatewayOrgPlan } from "./gateway-admin";
import { getSettings } from "../settings";

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

/** The gateway plan id every price in a subscription's items maps to, or
 *  undefined when none of them is a plan price. First match wins: a
 *  subscription carrying one plan price plus add-on prices still resolves. */
export function planIdForPrices(
  obj: Record<string, unknown>,
  map: Record<string, string>,
): string | undefined {
  const items = rec(obj.items)?.data;
  if (!Array.isArray(items)) return undefined;
  for (const item of items) {
    const priceId = idOf(rec(item)?.price);
    if (priceId && map[priceId]) return map[priceId];
  }
  return undefined;
}

/**
 * Which gateway plan a subscription event should leave the org on, or
 * undefined to leave the plan alone.
 *
 * The rule that answers "a non-renewed payment moves the org back to Free":
 *
 *  - `active` / `trialing` → the plan its price maps to. This is the ONLY way
 *    a paid tier is granted, which is what makes a tier something bought
 *    rather than something asked for.
 *  - `past_due` → unchanged. Stripe is still dunning and the card may yet
 *    clear; `task-quota.ts` already treats past_due as grace, and the two must
 *    not disagree about what a delinquent org can do.
 *  - anything else (canceled, unpaid, incomplete_expired, paused) → `free`.
 *
 * A subscription whose price is not in the map grants nothing on the way in —
 * but still drops the org to free on the way out, because an org holding a
 * paid tier must never keep it just because its price was later unmapped.
 */
export function planIdForStripe(
  status: string,
  obj: Record<string, unknown>,
  map: Record<string, string>,
): string | undefined {
  if (status === "past_due") return undefined;
  if (status !== "active") return "free";
  return planIdForPrices(obj, map);
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
      /** A paid AI-credit top-up to forward to the gateway (route wrapper
       *  credits it; a failure THROWS so Stripe redelivers — Stripe is the
       *  retry queue, the gateway referenceId dedupe makes replays no-ops). */
      topUp?: { creditCents: number; referenceId: string };
      /** The gateway plan this event grants or revokes. Applied by the route
       *  wrapper, and THROWS on failure like the top-up does, for the same
       *  reason: an entitlement that silently fails to land is a customer
       *  paying for a tier they do not have — or keeping one they stopped
       *  paying for. Absent = leave the plan alone. */
      planChange?: { planId: string; note: string };
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

      // AI-credit top-up (mode=payment, metadata.kind=topup — set by our own
      // checkout creator). Orthogonal to the subscription: NO billing-row
      // writes, no watermark. The gateway credit happens in the route wrapper.
      if (s(rec(obj.metadata)?.kind) === "topup") {
        if (obj.mode !== "payment") {
          return { handled: false, reason: "topup with wrong mode" };
        }
        if (s(obj.payment_status) !== "paid") {
          return { handled: false, reason: "payment not confirmed" };
        }
        const sessionId = s(obj.id);
        if (!sessionId) {
          // No deterministic dedupe key — a random one would double-credit
          // on redelivery (completed + async_payment_succeeded both land
          // here). Sessions always carry ids; absence is malformed.
          console.error("stripe webhook: topup session without id", {
            eventId: event.id,
            organizationId,
          });
          return { handled: false, reason: "topup session without id" };
        }
        const creditCents = Number(rec(obj.metadata)?.creditCents);
        if (!Number.isInteger(creditCents) || creditCents <= 0) {
          // Money captured but the credit can't be computed — our own
          // checkout creator wrote this metadata, so this is a bug. Loud but
          // 200-acked: throwing would redeliver a deterministic failure.
          console.error(
            "stripe webhook: paid topup with bad metadata — credit NOT applied",
            {
              eventId: event.id,
              organizationId,
              creditCents: rec(obj.metadata)?.creditCents,
            },
          );
          return { handled: false, reason: "bad topup metadata" };
        }
        return {
          handled: true,
          organizationId,
          topUp: {
            creditCents,
            referenceId: `stripe-topup:${sessionId}`,
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
      // The plan the buyer paid for, from the metadata OUR checkout creator
      // wrote — a Checkout Session carries no line items unless expanded, so
      // the price map cannot be consulted here. `customer.subscription.updated`
      // fires for the same subscription with real items and resolves it again
      // from the price, so a session with no planId is not a hole: it just
      // grants nothing until that event lands.
      const planId = s(rec(obj.metadata)?.planId);
      return {
        handled: true,
        organizationId,
        ...(planId
          ? {
              planChange: {
                planId,
                note: `stripe checkout ${s(obj.id) ?? ""}`.trim(),
              },
            }
          : {}),
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
      await storage.updateStripeState(billing.organizationId, {
        status,
        currentPeriodEnd: subscriptionPeriodEnd(obj),
        ...(isDeleted && { stripeSubscriptionId: null }),
        lastStripeEventAt: nextWatermark(event, billing),
      });
      // This is where a lapsed payment becomes a lapsed entitlement. Without
      // it the billing row said `canceled` and the org kept every paid feature
      // and its full AI allowance, indefinitely.
      const planId = planIdForStripe(
        status,
        obj,
        getSettings().stripePlanPriceIds,
      );
      return {
        handled: true,
        organizationId: billing.organizationId,
        ...(planId
          ? { planChange: { planId, note: `stripe ${event.type} (${status})` } }
          : {}),
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
      // THE monthly clock: refresh period end; active here is also the
      // unpaid→paid recovery (a deleted subscription can't reach this).
      await storage.updateStripeState(billing.organizationId, {
        status: "active",
        currentPeriodEnd: epochToDate(obj.period_end),
        lastStripeEventAt: nextWatermark(event, billing),
      });
      // The other half of the recovery: an org dropped to free by a failed
      // payment has to get its tier BACK when the invoice settles, or the
      // downgrade is one-way. An invoice's lines carry the price, so the map
      // resolves here without fetching the subscription.
      const planId = planIdForPrices(
        { items: obj.lines },
        getSettings().stripePlanPriceIds,
      );
      return {
        handled: true,
        organizationId: billing.organizationId,
        ...(planId
          ? { planChange: { planId, note: "stripe invoice.paid" } }
          : {}),
      };
    }

    default:
      return { handled: false, reason: `unhandled event ${event.type}` };
  }
}

/** Pure mapping: which subscription-lifecycle funnel event (if any) a webhook
 *  delivery represents. Null for unhandled results, test-mode traffic
 *  (livemode:false must not land in the PLG dashboards), and a subscription's
 *  FIRST invoice — that moment is subscription_started (the checkout event),
 *  counting it as a renewal would overcount renewals by one per subscriber.
 *  Exported for unit tests. */
export function subscriptionFunnelEvent(
  event: StripeEvent,
  result: HandledStripeEvent,
): {
  name: string;
  organizationId: string;
  properties: Record<string, unknown>;
} | null {
  if (!result.handled || event.livemode === false) return null;
  const obj = event.data.object;
  if (result.topUp) {
    return {
      name: "credits_topup_succeeded",
      organizationId: result.organizationId,
      properties: { credit_cents: result.topUp.creditCents },
    };
  }
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return {
        name: "subscription_started",
        organizationId: result.organizationId,
        properties: {},
      };
    case "customer.subscription.deleted":
      return {
        name: "subscription_canceled",
        organizationId: result.organizationId,
        properties: {},
      };
    case "customer.subscription.updated":
      return {
        name: "subscription_updated",
        organizationId: result.organizationId,
        properties: {
          status: mapSubscriptionStatus(obj.status),
          // Churn intent: a scheduled cancel keeps status "active" — this is
          // the only place it's visible.
          ...(typeof obj.cancel_at_period_end === "boolean"
            ? { cancel_at_period_end: obj.cancel_at_period_end }
            : {}),
        },
      };
    case "invoice.paid":
      if (obj.billing_reason === "subscription_create") return null;
      return {
        name: "subscription_renewed",
        organizationId: result.organizationId,
        properties: {},
      };
    default:
      return null;
  }
}

/** Emit the mapped funnel event. Stripe is at-least-once even on success, so
 *  the uuid + timestamp pair is deterministic per (event id, event name) —
 *  PostHog collapses redeliveries server-side. Fire-and-forget. */
function captureSubscriptionEvent(
  event: StripeEvent,
  result: HandledStripeEvent,
): void {
  const mapped = subscriptionFunnelEvent(event, result);
  if (!mapped) return;
  captureOrgEvent({
    event: mapped.name,
    organizationId: mapped.organizationId,
    ...(event.id
      ? { uuid: deterministicUuid(`stripe:${event.id}:${mapped.name}`) }
      : {}),
    ...(event.created ? { timestamp: new Date(event.created * 1000) } : {}),
    properties: mapped.properties,
  });
}

/** Route-facing wrapper: apply, then clean up refused-but-paid orphans. */
export async function processStripeEvent(
  event: StripeEvent,
): Promise<HandledStripeEvent> {
  const storage = new OrganizationBillingStorage(getDb().db);
  const result = await applyStripeEvent(storage, event);
  // The top-up's event is emitted only AFTER the gateway credit lands below —
  // "succeeded" must not fire for money that hasn't been applied (and a
  // gateway outage means Stripe redelivers this event for days).
  if (!(result.handled && result.topUp)) {
    captureSubscriptionEvent(event, result);
  }
  // Top-up: forward the paid credits to the gateway. NOT fail-soft — a throw
  // 500s the route so Stripe redelivers, and the gateway referenceId dedupe
  // makes every replay a no-op. Stripe is the retry queue here.
  if (result.handled && result.topUp) {
    await creditGatewayTopUp({
      organizationId: result.organizationId,
      amountCents: result.topUp.creditCents,
      referenceId: result.topUp.referenceId,
    });
    // Only now did the top-up actually succeed.
    captureSubscriptionEvent(event, result);
  }
  // Grant or revoke the tier the payment state implies. After the billing
  // write and before the orphan cleanup, and NOT fail-soft: a throw 500s the
  // route so Stripe redelivers, and placing a plan is idempotent at the
  // gateway. Failing soft here would leave an org paying for a tier it does
  // not have, or holding one it stopped paying for — both silently.
  if (result.handled && result.planChange) {
    await setGatewayOrgPlan({
      organizationId: result.organizationId,
      planId: result.planChange.planId,
      note: result.planChange.note,
    });
    // Same courtesy `AI_PLAN_SET` does after a downgrade. Only this process —
    // the cache is a per-pod Map and other pods wait out their 60s TTL — but
    // the grant path did not invalidate at all, so a customer who had just
    // paid could be refused their new features by the very pod that took the
    // webhook.
    invalidateOrgFeaturesCache(result.organizationId);
  }
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
