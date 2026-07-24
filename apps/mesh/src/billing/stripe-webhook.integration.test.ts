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
// org, mirroring subscription lifecycle, and the invoice.paid monthly clock —
// including the deterministic reference ids that collapse Stripe redeliveries.
const ORG = "org_stripe_1";

function event(type: string, object: Record<string, unknown>): StripeEvent {
  return { type, data: { object } };
}

describe("applyStripeEvent", () => {
  let database: StudioDatabase;
  let storage: OrganizationBillingStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await database.db
      .insertInto("organization")
      .values({
        id: ORG,
        name: "Stripe Org",
        slug: "stripe-org",
        createdAt: new Date().toISOString(),
      })
      .execute();
    await database.db
      .insertInto("organization_billing")
      .values({ organization_id: ORG, legacy: false })
      .execute();
    storage = new OrganizationBillingStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("checkout.session.completed binds the subscription and marks the grant", async () => {
    const result = await applyStripeEvent(
      storage,
      event("checkout.session.completed", {
        id: "cs_1",
        mode: "subscription",
        customer: "cus_1",
        subscription: "sub_1",
        metadata: { orgId: ORG },
      }),
    );
    expect(result.handled).toBe(true);

    const billing = await storage.getBilling(ORG);
    expect(billing?.stripeCustomerId).toBe("cus_1");
    expect(billing?.stripeSubscriptionId).toBe("sub_1");
    expect(billing?.status).toBe("active");
    expect(billing?.benefitsReferenceId).toBe("stripe-checkout:cs_1");
  });

  it("subscription.updated mirrors status + period end, keyed by Stripe id", async () => {
    const periodEnd = 1_800_000_000;
    const result = await applyStripeEvent(
      storage,
      event("customer.subscription.updated", {
        id: "sub_1",
        status: "past_due",
        current_period_end: periodEnd,
      }),
    );
    expect(result.handled).toBe(true);

    const billing = await storage.getBilling(ORG);
    expect(billing?.status).toBe("past_due");
    expect(billing?.currentPeriodEnd?.getTime()).toBe(periodEnd * 1000);
    // Deterministic per (sub, status, period): a redelivery re-marks the SAME
    // reference — one gateway rebase, not two.
    expect(billing?.benefitsReferenceId).toBe(
      `stripe-sub:sub_1:past_due:${periodEnd * 1000}`,
    );
  });

  it("invoice.paid is the monthly clock: reactivates and re-marks per invoice id", async () => {
    const result = await applyStripeEvent(
      storage,
      event("invoice.paid", {
        id: "in_42",
        subscription: "sub_1",
        period_end: 1_802_592_000,
      }),
    );
    expect(result.handled).toBe(true);

    const billing = await storage.getBilling(ORG);
    expect(billing?.status).toBe("active");
    expect(billing?.benefitsReferenceId).toBe("stripe-invoice:in_42");
  });

  it("subscription.deleted cancels service", async () => {
    const result = await applyStripeEvent(
      storage,
      event("customer.subscription.deleted", {
        id: "sub_1",
        status: "canceled",
      }),
    );
    expect(result.handled).toBe(true);
    expect((await storage.getBilling(ORG))?.status).toBe("canceled");
  });

  it("unknown orgs/subscriptions and non-subscription checkouts are acked no-ops", async () => {
    const unknownSub = await applyStripeEvent(
      storage,
      event("customer.subscription.updated", { id: "sub_ghost" }),
    );
    expect(unknownSub.handled).toBe(false);

    const unknownOrg = await applyStripeEvent(
      storage,
      event("checkout.session.completed", {
        id: "cs_2",
        mode: "subscription",
        metadata: { orgId: "org_ghost" },
      }),
    );
    expect(unknownOrg.handled).toBe(false);

    const payment = await applyStripeEvent(
      storage,
      event("checkout.session.completed", {
        id: "cs_3",
        mode: "payment",
        metadata: { orgId: ORG },
      }),
    );
    expect(payment.handled).toBe(false);

    const unhandled = await applyStripeEvent(
      storage,
      event("charge.refunded", { id: "ch_1" }),
    );
    expect(unhandled.handled).toBe(false);
  });
});
