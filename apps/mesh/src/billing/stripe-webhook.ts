/**
 * Stripe webhook intake for per-seat self-serve billing (phase 3).
 *
 * The webhook is the SOURCE OF TRUTH writer for organization_billing's
 * subscription state — checkout/portal flows only send users to Stripe; what
 * comes back here is what we believe. Handlers are idempotent (state-setting
 * writes + gateway-deduped benefit grants), so Stripe redeliveries are safe.
 *
 * Events:
 *  - checkout.session.completed  → bind customer/subscription to the org
 *    (metadata.orgId, set by our checkout creator), status active, grant.
 *  - customer.subscription.updated → mirror status + current_period_end.
 *  - customer.subscription.deleted → status canceled, grant recomputes to 0
 *    (the sync workflow zeroes self_serve orgs whose status isn't good).
 *  - invoice.paid → THE MONTHLY CLOCK: refresh period end + re-grant with
 *    referenceId = invoice id, which is what makes the gateway allowance
 *    reset per billing cycle (no cron anywhere).
 *
 * Signature: Stripe's v1 scheme (HMAC-SHA256 over `${t}.${rawBody}`),
 * verified timing-safe — same hand-rolled approach as the reports worker; the
 * Stripe SDK arrives with the checkout/preview API surface, not for this.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { getDb } from "@/database";
import { OrganizationBillingStorage } from "../storage/organization-billing";
import { enqueueBenefitsSync } from "./sync-org-benefits";

export async function verifyStripeSignature(
  rawBody: string,
  sigHeader: string | null | undefined,
  secret: string | undefined,
): Promise<boolean> {
  if (!sigHeader || !secret) return false;
  const parts: Record<string, string> = {};
  for (const kv of sigHeader.split(",")) {
    const i = kv.indexOf("=");
    if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  if (!parts.t || !parts.v1) return false;
  const expected = createHmac("sha256", secret)
    .update(`${parts.t}.${rawBody}`)
    .digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(parts.v1, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The slice of a Stripe event the handlers consume. */
export interface StripeEvent {
  type: string;
  data: { object: Record<string, unknown> };
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
      // canceled, unpaid, incomplete_expired, paused… — no service.
      return "canceled";
  }
}

function s(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function epochToDate(v: unknown): Date | null {
  return typeof v === "number" ? new Date(v * 1000) : null;
}

export type HandledStripeEvent =
  | { handled: false; reason: string }
  | { handled: true; organizationId: string; benefitsReferenceId?: string };

/**
 * Apply one Stripe event to billing state. Pure-ish over the storage: returns
 * what changed so the route can enqueue the benefit delivery AFTER the write
 * committed. Unknown org / unknown event types are acknowledged no-ops —
 * Stripe must get its 200 either way, redelivery wouldn't help.
 */
export async function applyStripeEvent(
  storage: OrganizationBillingStorage,
  event: StripeEvent,
): Promise<HandledStripeEvent> {
  const obj = event.data.object;

  switch (event.type) {
    case "checkout.session.completed": {
      const organizationId = s(
        (obj.metadata as Record<string, unknown> | undefined)?.orgId,
      );
      if (!organizationId) return { handled: false, reason: "no orgId" };
      if (obj.mode !== "subscription") {
        return { handled: false, reason: "not a subscription checkout" };
      }
      const updated = await storage.updateStripeState(organizationId, {
        stripeCustomerId: s(obj.customer),
        stripeSubscriptionId: s(obj.subscription),
        status: "active",
      });
      if (!updated) return { handled: false, reason: "unknown org" };
      const referenceId = `stripe-checkout:${s(obj.id) ?? crypto.randomUUID()}`;
      await storage.markBenefitsPending(organizationId, referenceId);
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
      const status =
        event.type === "customer.subscription.deleted"
          ? "canceled"
          : mapSubscriptionStatus(obj.status);
      await storage.updateStripeState(billing.organizationId, {
        status,
        currentPeriodEnd: epochToDate(obj.current_period_end),
      });
      // Status changes move the effective grant (canceled → 0) — re-deliver.
      // Deterministic per (sub, status, period) so redeliveries collapse.
      const referenceId = `stripe-sub:${subscriptionId}:${status}:${
        epochToDate(obj.current_period_end)?.getTime() ?? 0
      }`;
      await storage.markBenefitsPending(billing.organizationId, referenceId);
      return {
        handled: true,
        organizationId: billing.organizationId,
        benefitsReferenceId: referenceId,
      };
    }

    case "invoice.paid": {
      const subscriptionId = s(obj.subscription);
      if (!subscriptionId) return { handled: false, reason: "no sub id" };
      const billing =
        await storage.getBillingByStripeSubscriptionId(subscriptionId);
      if (!billing) return { handled: false, reason: "unknown subscription" };
      await storage.updateStripeState(billing.organizationId, {
        status: "active",
        currentPeriodEnd: epochToDate(obj.period_end),
      });
      // THE monthly reset: deterministic reference (invoice id) so Stripe
      // redeliveries collapse into one gateway rebase per cycle.
      const referenceId = `stripe-invoice:${s(obj.id) ?? crypto.randomUUID()}`;
      await storage.markBenefitsPending(billing.organizationId, referenceId);
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
