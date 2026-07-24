import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { OrganizationBillingStorage } from "../storage/organization-billing";
import { applyStripeEvent, type StripeEvent } from "./stripe-webhook";

// Real-Postgres coverage for the webhook handlers: binding a checkout to the
// org, mirroring subscription lifecycle, the invoice.paid monthly clock, and
// the two ordering rules — the last_stripe_event_at high-water mark (stale
// deliveries skipped) and terminal deletes (exempt + unbind), which together
// make Stripe's unordered redeliveries unable to resurrect a canceled org.
const ORG = "org_stripe_1";
const ORG_LEGACY = "org_stripe_legacy";
const ORG_INVOICED = "org_stripe_invoiced";
const ORG_BASIL = "org_stripe_basil";

// Event-created timeline (epoch seconds).
const T1 = 1_800_000_010;
const T2 = 1_800_000_020;
const T3 = 1_800_000_030;
const T5 = 1_800_000_050;
const T6 = 1_800_000_060;
const PERIOD_1 = 1_800_100_000;
const PERIOD_2 = 1_800_200_000;

function event(
  type: string,
  object: Record<string, unknown>,
  created?: number,
): StripeEvent {
  return { type, created, data: { object } };
}

function checkout(object: Record<string, unknown>, created?: number) {
  return event(
    "checkout.session.completed",
    {
      mode: "subscription",
      payment_status: "paid",
      ...object,
    },
    created,
  );
}

describe("applyStripeEvent", () => {
  let database: StudioDatabase;
  let storage: OrganizationBillingStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const orgs = [ORG, ORG_LEGACY, ORG_INVOICED, ORG_BASIL];
    await database.db
      .insertInto("organization")
      .values(
        orgs.map((id) => ({
          id,
          name: `Stripe ${id}`,
          slug: id.replaceAll("_", "-"),
          createdAt: new Date().toISOString(),
        })),
      )
      .execute();
    await database.db
      .insertInto("organization_billing")
      .values([
        { organization_id: ORG, legacy: false },
        { organization_id: ORG_LEGACY, legacy: true },
        {
          organization_id: ORG_INVOICED,
          legacy: false,
          billing_mode: "invoiced",
        },
        { organization_id: ORG_BASIL, legacy: false },
      ])
      .execute();
    storage = new OrganizationBillingStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("checkout.session.completed binds the subscription and marks the grant", async () => {
    const result = await applyStripeEvent(
      storage,
      checkout(
        {
          id: "cs_1",
          customer: "cus_1",
          subscription: "sub_1",
          metadata: { orgId: ORG },
        },
        T1,
      ),
    );
    expect(result.handled).toBe(true);

    const billing = await storage.getBilling(ORG);
    expect(billing?.stripeCustomerId).toBe("cus_1");
    expect(billing?.stripeSubscriptionId).toBe("sub_1");
    expect(billing?.status).toBe("active");
    expect(billing?.benefitsReferenceId).toBe("stripe-checkout:cs_1");
    expect(billing?.lastStripeEventAt?.getTime()).toBe(T1 * 1000);
  });

  it("subscription.updated mirrors status + period end, keyed by Stripe id", async () => {
    const updated = event(
      "customer.subscription.updated",
      { id: "sub_1", status: "past_due", current_period_end: PERIOD_1 },
      T2,
    );
    const result = await applyStripeEvent(storage, updated);
    expect(result.handled).toBe(true);

    const billing = await storage.getBilling(ORG);
    expect(billing?.status).toBe("past_due");
    expect(billing?.currentPeriodEnd?.getTime()).toBe(PERIOD_1 * 1000);
    // Deterministic per (sub, status, period): a redelivery re-marks the SAME
    // reference — one gateway rebase, not two.
    const referenceId = `stripe-sub:sub_1:past_due:${PERIOD_1 * 1000}`;
    expect(billing?.benefitsReferenceId).toBe(referenceId);

    // Redelivery of the exact same event: same state, same reference.
    const redelivered = await applyStripeEvent(storage, updated);
    expect(redelivered.handled).toBe(true);
    const after = await storage.getBilling(ORG);
    expect(after?.status).toBe("past_due");
    expect(after?.benefitsReferenceId).toBe(referenceId);
  });

  it("skips a stale subscription.updated (out-of-order delivery)", async () => {
    const result = await applyStripeEvent(
      storage,
      event(
        "customer.subscription.updated",
        { id: "sub_1", status: "active" },
        T1,
      ),
    );
    expect(result).toEqual({ handled: false, reason: "stale event" });
    expect((await storage.getBilling(ORG))?.status).toBe("past_due");
  });

  it("invoice.paid is the monthly clock: reactivates and re-marks per invoice id", async () => {
    const paid = event(
      "invoice.paid",
      { id: "in_42", subscription: "sub_1", period_end: PERIOD_2 },
      T3,
    );
    const result = await applyStripeEvent(storage, paid);
    expect(result.handled).toBe(true);

    const billing = await storage.getBilling(ORG);
    expect(billing?.status).toBe("active");
    expect(billing?.currentPeriodEnd?.getTime()).toBe(PERIOD_2 * 1000);
    expect(billing?.benefitsReferenceId).toBe("stripe-invoice:in_42");

    // Stripe redelivery collapses into the same reference and state.
    const redelivered = await applyStripeEvent(storage, paid);
    expect(redelivered.handled).toBe(true);
    expect((await storage.getBilling(ORG))?.benefitsReferenceId).toBe(
      "stripe-invoice:in_42",
    );
  });

  it("subscription.deleted cancels service and unbinds the subscription", async () => {
    const result = await applyStripeEvent(
      storage,
      event(
        "customer.subscription.deleted",
        { id: "sub_1", status: "canceled" },
        T5,
      ),
    );
    expect(result.handled).toBe(true);
    const billing = await storage.getBilling(ORG);
    expect(billing?.status).toBe("canceled");
    expect(billing?.stripeSubscriptionId).toBeNull();
  });

  it("a late invoice.paid can NOT resurrect a canceled org", async () => {
    // Stripe retries for days; the sub is unbound, so this resolves to
    // nothing instead of flipping the org back to active forever.
    const result = await applyStripeEvent(
      storage,
      event(
        "invoice.paid",
        { id: "in_41", subscription: "sub_1", period_end: PERIOD_1 },
        T3,
      ),
    );
    expect(result).toEqual({ handled: false, reason: "unknown subscription" });
    expect((await storage.getBilling(ORG))?.status).toBe("canceled");
  });

  it("re-subscribe binds fresh (async_payment_succeeded counts as paid)", async () => {
    const result = await applyStripeEvent(storage, {
      ...checkout(
        {
          id: "cs_2",
          customer: "cus_1",
          subscription: "sub_2",
          metadata: { orgId: ORG },
        },
        T6,
      ),
      type: "checkout.session.async_payment_succeeded",
    });
    expect(result.handled).toBe(true);
    const billing = await storage.getBilling(ORG);
    expect(billing?.stripeSubscriptionId).toBe("sub_2");
    expect(billing?.status).toBe("active");
  });

  it("subscription.deleted is terminal: applies even delivered out of order", async () => {
    // created T5 < watermark T6 — deleted is exempt from the staleness check
    // (a deleted subscription never comes back), and the mark never regresses.
    const result = await applyStripeEvent(
      storage,
      event(
        "customer.subscription.deleted",
        { id: "sub_2", status: "canceled" },
        T5,
      ),
    );
    expect(result.handled).toBe(true);
    const billing = await storage.getBilling(ORG);
    expect(billing?.status).toBe("canceled");
    expect(billing?.stripeSubscriptionId).toBeNull();
    expect(billing?.lastStripeEventAt?.getTime()).toBe(T6 * 1000);
  });

  it("checkout refuses unpaid sessions and legacy/invoiced orgs", async () => {
    const unpaid = await applyStripeEvent(
      storage,
      checkout({
        id: "cs_u",
        payment_status: "unpaid",
        subscription: "sub_u",
        metadata: { orgId: ORG_BASIL },
      }),
    );
    expect(unpaid).toEqual({ handled: false, reason: "payment not confirmed" });

    for (const orgId of [ORG_LEGACY, ORG_INVOICED]) {
      const refused = await applyStripeEvent(
        storage,
        checkout({ id: "cs_x", subscription: "sub_x", metadata: { orgId } }),
      );
      expect(refused).toEqual({
        handled: false,
        reason: "org is not self-serve",
      });
      expect(
        (await storage.getBilling(orgId))?.stripeSubscriptionId,
      ).toBeNull();
    }
  });

  it("reads Basil (2025-03-31) payload shapes; rebinds are refused", async () => {
    // Bind normally first.
    const bound = await applyStripeEvent(
      storage,
      checkout(
        {
          id: "cs_b1",
          customer: "cus_b1",
          subscription: "sub_b1",
          metadata: { orgId: ORG_BASIL },
        },
        T1,
      ),
    );
    expect(bound.handled).toBe(true);

    // A checkout for an org still bound to a DIFFERENT live subscription is
    // refused — metadata.orgId must not be able to hijack billing state.
    const rebind = await applyStripeEvent(
      storage,
      checkout({
        id: "cs_evil",
        subscription: "sub_evil",
        metadata: { orgId: ORG_BASIL },
      }),
    );
    // The refusal names the orphan so the route wrapper can cancel the
    // subscription the customer just paid for.
    expect(rebind).toEqual({
      handled: false,
      reason: "org already bound to another subscription",
      orphanSubscriptionId: "sub_evil",
    });
    expect((await storage.getBilling(ORG_BASIL))?.stripeSubscriptionId).toBe(
      "sub_b1",
    );

    // Basil: current_period_end lives on items.data[], not the subscription.
    const updated = await applyStripeEvent(
      storage,
      event(
        "customer.subscription.updated",
        {
          id: "sub_b1",
          status: "active",
          items: { data: [{ current_period_end: PERIOD_1 }] },
        },
        T2,
      ),
    );
    expect(updated.handled).toBe(true);
    expect(
      (await storage.getBilling(ORG_BASIL))?.currentPeriodEnd?.getTime(),
    ).toBe(PERIOD_1 * 1000);

    // Basil: invoice.subscription moved under invoice.parent.
    const paid = await applyStripeEvent(
      storage,
      event(
        "invoice.paid",
        {
          id: "in_b1",
          parent: { subscription_details: { subscription: "sub_b1" } },
          period_end: PERIOD_2,
        },
        T3,
      ),
    );
    expect(paid.handled).toBe(true);
    const billing = await storage.getBilling(ORG_BASIL);
    expect(billing?.status).toBe("active");
    expect(billing?.benefitsReferenceId).toBe("stripe-invoice:in_b1");
  });

  it("unknown orgs/subscriptions and non-subscription checkouts are acked no-ops", async () => {
    const unknownSub = await applyStripeEvent(
      storage,
      event("customer.subscription.updated", { id: "sub_ghost" }),
    );
    expect(unknownSub.handled).toBe(false);

    const unknownOrg = await applyStripeEvent(
      storage,
      checkout({ id: "cs_ghost", metadata: { orgId: "org_ghost" } }),
    );
    expect(unknownOrg.handled).toBe(false);

    const payment = await applyStripeEvent(
      storage,
      checkout({ id: "cs_pay", mode: "payment", metadata: { orgId: ORG } }),
    );
    expect(payment.handled).toBe(false);

    const unhandled = await applyStripeEvent(
      storage,
      event("charge.refunded", { id: "ch_1" }),
    );
    expect(unhandled.handled).toBe(false);
  });

  it("top-up: paid payment-mode checkout returns the gateway credit intent", async () => {
    const before = await storage.getBilling(ORG_LEGACY);
    const result = await applyStripeEvent(
      storage,
      event("checkout.session.completed", {
        id: "cs_topup_1",
        mode: "payment",
        payment_status: "paid",
        metadata: { kind: "topup", orgId: ORG_LEGACY, creditCents: "1000" },
      }),
    );
    // Deliberately allowed for LEGACY orgs — credits are orthogonal to seats.
    expect(result).toEqual({
      handled: true,
      organizationId: ORG_LEGACY,
      topUp: { creditCents: 1000, referenceId: "stripe-topup:cs_topup_1" },
    });
    // No billing-row writes: top-ups never touch subscription state.
    expect(await storage.getBilling(ORG_LEGACY)).toEqual(before);
  });

  it("top-up: unpaid sessions and bad metadata are acked no-ops", async () => {
    const unpaid = await applyStripeEvent(
      storage,
      event("checkout.session.completed", {
        id: "cs_topup_2",
        mode: "payment",
        payment_status: "unpaid",
        metadata: { kind: "topup", orgId: ORG, creditCents: "1000" },
      }),
    );
    expect(unpaid.handled).toBe(false);

    const badAmount = await applyStripeEvent(
      storage,
      event("checkout.session.completed", {
        id: "cs_topup_3",
        mode: "payment",
        payment_status: "paid",
        metadata: { kind: "topup", orgId: ORG, creditCents: "-5" },
      }),
    );
    expect(badAmount.handled).toBe(false);

    // A topup-kind session in subscription mode is malformed — rejected.
    const wrongMode = await applyStripeEvent(
      storage,
      event("checkout.session.completed", {
        id: "cs_topup_4",
        mode: "subscription",
        payment_status: "paid",
        metadata: { kind: "topup", orgId: ORG, creditCents: "1000" },
      }),
    );
    expect(wrongMode.handled).toBe(false);

    // No session id ⇒ no deterministic dedupe key ⇒ a credit intent here
    // could double-credit on redelivery. Acked no-op instead.
    const noId = await applyStripeEvent(
      storage,
      event("checkout.session.completed", {
        mode: "payment",
        payment_status: "paid",
        metadata: { kind: "topup", orgId: ORG, creditCents: "1000" },
      }),
    );
    expect(noId.handled).toBe(false);
  });

  it("top-up: async_payment_succeeded yields the SAME referenceId as completed — the double-credit defense for delayed payment methods", async () => {
    const session = {
      id: "cs_topup_async",
      mode: "payment",
      payment_status: "unpaid",
      metadata: { kind: "topup", orgId: ORG, creditCents: "2500" },
    };
    // Delayed method: completed fires while unpaid — no credit intent yet.
    const completed = await applyStripeEvent(
      storage,
      event("checkout.session.completed", session),
    );
    expect(completed.handled).toBe(false);

    // Payment confirms later via async_payment_succeeded.
    const confirmed = await applyStripeEvent(
      storage,
      event("checkout.session.async_payment_succeeded", {
        ...session,
        payment_status: "paid",
      }),
    );
    expect(confirmed).toEqual({
      handled: true,
      organizationId: ORG,
      topUp: { creditCents: 2500, referenceId: "stripe-topup:cs_topup_async" },
    });

    // A redelivered completed event that is NOW paid mints the same
    // referenceId — the gateway ledger dedupes the replay to a no-op.
    const replay = await applyStripeEvent(
      storage,
      event("checkout.session.completed", {
        ...session,
        payment_status: "paid",
      }),
    );
    expect(replay).toEqual(confirmed);
  });
});
