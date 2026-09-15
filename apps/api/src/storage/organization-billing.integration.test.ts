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

  /**
   * The compare-and-set that makes a double charge impossible rather than
   * merely refundable. Two checkout completions racing for one org used to
   * both read a null subscription, both pass the rebind refusal, and both
   * write — the loser billing the customer for ever, uncancelled, because the
   * guard meant to catch it never fired.
   */
  describe("bindSubscription", () => {
    it("the first subscription wins the empty slot", async () => {
      await storage.updateStripeState(ORG, { stripeSubscriptionId: null });
      expect(
        await storage.bindSubscription(ORG, {
          stripeSubscriptionId: "sub_first",
          status: "active",
        }),
      ).toBe(true);
      expect((await storage.getBilling(ORG))?.stripeSubscriptionId).toBe(
        "sub_first",
      );
    });

    it("a SECOND subscription is refused, and does not overwrite the winner", async () => {
      await storage.updateStripeState(ORG, { stripeSubscriptionId: null });
      await storage.bindSubscription(ORG, {
        stripeSubscriptionId: "sub_winner",
        status: "active",
      });
      expect(
        await storage.bindSubscription(ORG, {
          stripeSubscriptionId: "sub_loser",
          status: "active",
        }),
      ).toBe(false);
      // The whole point: the loser is reported so it can be reversed, and the
      // row still points at the subscription that actually got the slot.
      expect((await storage.getBilling(ORG))?.stripeSubscriptionId).toBe(
        "sub_winner",
      );
    });

    it("re-binding the SAME subscription succeeds — a redelivery is not a second sub", async () => {
      await storage.updateStripeState(ORG, { stripeSubscriptionId: null });
      await storage.bindSubscription(ORG, {
        stripeSubscriptionId: "sub_same",
        status: "active",
      });
      expect(
        await storage.bindSubscription(ORG, {
          stripeSubscriptionId: "sub_same",
          status: "active",
        }),
      ).toBe(true);
    });

    it("only one of many concurrent binds wins", async () => {
      // The actual race, run for real against Postgres rather than reasoned
      // about: eight simultaneous binds, exactly one slot.
      await storage.updateStripeState(ORG, { stripeSubscriptionId: null });
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          storage.bindSubscription(ORG, {
            stripeSubscriptionId: `sub_race_${i}`,
            status: "active",
          }),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const bound = (await storage.getBilling(ORG))?.stripeSubscriptionId;
      expect(bound).toMatch(/^sub_race_\d$/);
    });

    it("an unbound org is untouched by a bind for a different org", async () => {
      expect(
        await storage.bindSubscription("org_missing", {
          stripeSubscriptionId: "sub_x",
        }),
      ).toBe(false);
    });
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
