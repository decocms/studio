import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { OrganizationBillingStorage } from "./organization-billing";

// Real-Postgres coverage: row mapping, updateStripeState patch semantics,
// subscription-id resolution (event ordering lives in the webhook tests).
const ORG = "org_billing_1";

describe("OrganizationBillingStorage", () => {
  let database: StudioDatabase;
  let storage: OrganizationBillingStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await database.db
      .insertInto("organization")
      .values({
        id: ORG,
        name: "Billing Org",
        slug: "billing-org",
        createdAt: new Date().toISOString(),
      })
      .execute();
    await database.db
      .insertInto("organization_billing")
      .values({ organization_id: ORG })
      .execute();
    storage = new OrganizationBillingStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("getBilling maps the row; missing row is null", async () => {
    const billing = await storage.getBilling(ORG);
    expect(billing).toMatchObject({
      organizationId: ORG,
      status: "none",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });
    expect(await storage.getBilling("org_missing")).toBeNull();
  });

  it("updateStripeState patches only the given fields and reports row presence", async () => {
    const when = new Date("2026-01-01T00:00:00Z");
    expect(
      await storage.updateStripeState(ORG, {
        stripeCustomerId: "cus_1",
        stripeSubscriptionId: "sub_1",
        status: "active",
        lastStripeEventAt: when,
      }),
    ).toBe(true);
    // Partial patch: untouched fields survive.
    await storage.updateStripeState(ORG, { status: "past_due" });
    const billing = await storage.getBilling(ORG);
    expect(billing).toMatchObject({
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      status: "past_due",
    });
    expect(billing?.lastStripeEventAt?.getTime()).toBe(when.getTime());
    // Explicit null unbinds the subscription (deleted event).
    await storage.updateStripeState(ORG, { stripeSubscriptionId: null });
    expect((await storage.getBilling(ORG))?.stripeSubscriptionId).toBeNull();
    // Unknown org: no row updated.
    expect(
      await storage.updateStripeState("org_missing", { status: "active" }),
    ).toBe(false);
  });

  it("resolves the org behind a Stripe subscription id", async () => {
    await storage.updateStripeState(ORG, { stripeSubscriptionId: "sub_2" });
    expect(
      (await storage.getBillingByStripeSubscriptionId("sub_2"))?.organizationId,
    ).toBe(ORG);
    expect(await storage.getBillingByStripeSubscriptionId("sub_none")).toBe(
      null,
    );
  });
});
