/**
 * Real-Postgres coverage for the money-flow guards — everything that fires
 * BEFORE any Stripe HTTP call, so no key and no network:
 *  - CHECKOUT_START's matrix: legacy / invoiced / already-active /
 *    bound-but-not-active (the orphan-payment hole) / zero staged seats.
 *  - SEATS_PREVIEW requires a chargeable subscription.
 *  - SEATS_SET applies by mode: invoiced directly; self_serve WITHOUT a
 *    subscription directly (staging); self_serve WITH an active subscription
 *    attempts the Stripe mirror — including on an all-no-op replay, which is
 *    the documented retry after a failed mirror (the rows-already-right case
 *    MUST still reach Stripe or "apply again" would be a lie).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../../database/test-db-pg";
import type { StudioContext } from "../../core/studio-context";
import { OrganizationBillingStorage } from "../../storage/organization-billing";
import {
  ORGANIZATION_BILLING_CHECKOUT_START,
  ORGANIZATION_SEATS_PREVIEW,
} from "./billing-checkout";
import { ORGANIZATION_SEATS_SET } from "./seats";

const USER = "user_1";

function makeCtx(
  database: StudioDatabase,
  organizationId: string,
): StudioContext {
  return {
    timings: {
      measure: async <T>(_name: string, cb: () => Promise<T>) => await cb(),
    },
    auth: { user: { id: USER, email: "user_1@test.com", name: "Test" } },
    organization: { id: organizationId, slug: organizationId, name: "Test" },
    storage: {
      organizationBilling: new OrganizationBillingStorage(database.db),
    },
    access: {
      granted: () => true,
      check: async () => {},
      grant: () => {},
      setToolName: () => {},
      setToolReadOnly: () => {},
    },
    tracer: {
      startActiveSpan: (
        _name: string,
        _opts: unknown,
        fn: (span: unknown) => unknown,
      ) =>
        fn({ setStatus: () => {}, recordException: () => {}, end: () => {} }),
    },
    meter: {
      createHistogram: () => ({ record: () => {} }),
      createCounter: () => ({ add: () => {} }),
    },
    metadata: { requestId: "req_test", timestamp: new Date() },
  } as unknown as StudioContext;
}

describe("billing money-flow guards", () => {
  let database: StudioDatabase;
  let storage: OrganizationBillingStorage;

  const ORG_LEGACY = "org_bg_legacy";
  const ORG_INVOICED = "org_bg_invoiced";
  const ORG_STAGING = "org_bg_staging"; // self_serve, no subscription yet
  const ORG_ACTIVE = "org_bg_active"; // self_serve, active + bound
  const ORG_DUNNING = "org_bg_dunning"; // self_serve, past_due + bound

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    const orgs = [
      ORG_LEGACY,
      ORG_INVOICED,
      ORG_STAGING,
      ORG_ACTIVE,
      ORG_DUNNING,
    ];
    const now = new Date().toISOString();
    await database.db
      .insertInto("organization")
      .values(
        orgs.map((id) => ({
          id,
          name: id,
          slug: id.replaceAll("_", "-"),
          createdAt: now,
        })),
      )
      .execute();
    await database.db
      .insertInto("member")
      .values(
        orgs.map((id) => ({
          id: `member_${id}`,
          organizationId: id,
          userId: USER,
          role: "owner",
          createdAt: now,
        })),
      )
      .execute();
    await database.db
      .insertInto("organization_billing")
      .values([
        { organization_id: ORG_LEGACY, legacy: true },
        {
          organization_id: ORG_INVOICED,
          legacy: false,
          billing_mode: "invoiced",
        },
        { organization_id: ORG_STAGING, legacy: false },
        {
          organization_id: ORG_ACTIVE,
          legacy: false,
          status: "active",
          stripe_subscription_id: "sub_active_1",
        },
        {
          organization_id: ORG_DUNNING,
          legacy: false,
          status: "past_due",
          stripe_subscription_id: "sub_dunning_1",
        },
      ])
      .execute();
    storage = new OrganizationBillingStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  describe("ORGANIZATION_BILLING_CHECKOUT_START guards", () => {
    it("rejects legacy and invoiced orgs", async () => {
      await expect(
        ORGANIZATION_BILLING_CHECKOUT_START.execute(
          {},
          makeCtx(database, ORG_LEGACY),
        ),
      ).rejects.toThrow(/legacy plan/);
      await expect(
        ORGANIZATION_BILLING_CHECKOUT_START.execute(
          {},
          makeCtx(database, ORG_INVOICED),
        ),
      ).rejects.toThrow(/Contract-billed/);
    });

    it("rejects an org with an active subscription", async () => {
      await expect(
        ORGANIZATION_BILLING_CHECKOUT_START.execute(
          {},
          makeCtx(database, ORG_ACTIVE),
        ),
      ).rejects.toThrow(/already has an active subscription/);
    });

    it("rejects a BOUND subscription even when not active — no second paid subscription", async () => {
      // past_due (and unpaid→canceled-without-unbind) still has a live
      // subscription on Stripe; a second checkout would strand the payment.
      await expect(
        ORGANIZATION_BILLING_CHECKOUT_START.execute(
          {},
          makeCtx(database, ORG_DUNNING),
        ),
      ).rejects.toThrow(/still has a subscription on file/);
    });

    it("rejects zero staged seats — a quantity-0 checkout must never exist", async () => {
      await expect(
        ORGANIZATION_BILLING_CHECKOUT_START.execute(
          {},
          makeCtx(database, ORG_STAGING),
        ),
      ).rejects.toThrow(/at least one member/);
    });
  });

  describe("ORGANIZATION_SEATS_PREVIEW guard", () => {
    it("requires a chargeable subscription (active + bound, self_serve)", async () => {
      for (const org of [ORG_LEGACY, ORG_INVOICED, ORG_STAGING, ORG_DUNNING]) {
        await expect(
          ORGANIZATION_SEATS_PREVIEW.execute(
            { quantity: 2 },
            makeCtx(database, org),
          ),
        ).rejects.toThrow(/active self-serve subscription/);
      }
    });
  });

  describe("ORGANIZATION_SEATS_SET by billing mode", () => {
    it("invoiced orgs apply directly, no Stripe involved", async () => {
      const result = await ORGANIZATION_SEATS_SET.execute(
        { seats: [{ userId: USER, seat: "paid" }] },
        makeCtx(database, ORG_INVOICED),
      );
      expect(result.applied).toEqual([{ userId: USER, seat: "paid" }]);
      expect(result.paidSeatCount).toBe(1);
    });

    it("self_serve WITHOUT a subscription stages seats directly (they charge at checkout)", async () => {
      const result = await ORGANIZATION_SEATS_SET.execute(
        { seats: [{ userId: USER, seat: "paid" }] },
        makeCtx(database, ORG_STAGING),
      );
      expect(result.applied).toEqual([{ userId: USER, seat: "paid" }]);
      expect(await storage.listPaidSeatUserIds(ORG_STAGING)).toEqual([USER]);
    });

    it("self_serve WITH an active subscription mirrors to Stripe — rows commit, mirror failure surfaces as retryable", async () => {
      // No STRIPE_SECRET_KEY in the test env, so the mirror deterministically
      // fails AFTER the rows commit — exactly the partial-failure state the
      // error copy describes.
      await expect(
        ORGANIZATION_SEATS_SET.execute(
          { seats: [{ userId: USER, seat: "paid" }] },
          makeCtx(database, ORG_ACTIVE),
        ),
      ).rejects.toThrow(/Seats saved, but updating the subscription failed/);
      expect(await storage.listPaidSeatUserIds(ORG_ACTIVE)).toEqual([USER]);
    });

    it("an all-no-op replay STILL attempts the Stripe mirror — the documented retry path", async () => {
      // Same seats again: rows are already right (applied would be empty),
      // but the mirror must still run or "apply again to retry the charge"
      // could never recover a failed mirror.
      await expect(
        ORGANIZATION_SEATS_SET.execute(
          { seats: [{ userId: USER, seat: "paid" }] },
          makeCtx(database, ORG_ACTIVE),
        ),
      ).rejects.toThrow(/Seats saved, but updating the subscription failed/);
    });

    it("self_serve past_due applies rows but does NOT charge the failing card", async () => {
      const result = await ORGANIZATION_SEATS_SET.execute(
        { seats: [{ userId: USER, seat: "paid" }] },
        makeCtx(database, ORG_DUNNING),
      );
      // No Stripe error — hasChargeableSubscription excludes past_due; the
      // webhook reconciles quantity on the next PAID invoice.
      expect(result.paidSeatCount).toBe(1);
    });
  });
});
