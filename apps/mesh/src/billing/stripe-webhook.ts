/**
 * Stripe webhook intake for per-seat self-serve billing (phase 3 — the
 * checkout/portal creator that sets metadata.orgId is phase 4; until it
 * ships AND the deployment sets STRIPE_WEBHOOK_SECRET, this module is
 * dormant).
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
 *    subscription.
 *  - customer.subscription.updated → mirror status + current period end.
 *  - customer.subscription.deleted → status canceled + unbind; grant
 *    recomputes to 0 (the sync workflow zeroes self_serve orgs whose
 *    subscription isn't good).
 *  - invoice.paid → THE MONTHLY CLOCK: refresh period end + re-grant with
 *    referenceId = invoice id, which is what makes the gateway allowance
 *    reset per billing cycle (no cron anywhere).
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
  | { handled: false; reason: string }
  | { handled: true; organizationId: string; benefitsReferenceId?: string };

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

/** Route-facing wrapper: apply + durable benefit delivery (fail-soft — the
 *  pending marker is committed, the scheduled sweep covers a lost enqueue). */
export async function processStripeEvent(
  event: StripeEvent,
): Promise<HandledStripeEvent> {
  const storage = new OrganizationBillingStorage(getDb().db);
  const result = await applyStripeEvent(storage, event);
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
  return result;
}
