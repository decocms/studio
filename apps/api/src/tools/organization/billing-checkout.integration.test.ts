/** Real-Postgres coverage for the checkout guards that fire BEFORE any
 *  Stripe HTTP call (no key, no network). */

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
import { ORGANIZATION_BILLING_CHECKOUT_START } from "./billing-checkout";

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

describe("ORGANIZATION_BILLING_CHECKOUT_START guards", () => {
  let database: StudioDatabase;

  const ORG_ACTIVE = "org_bg_active"; // active + bound
  const ORG_DUNNING = "org_bg_dunning"; // past_due + bound

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    const orgs = [ORG_ACTIVE, ORG_DUNNING];
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
        {
          organization_id: ORG_ACTIVE,
          status: "active",
          stripe_subscription_id: "sub_active_1",
        },
        {
          organization_id: ORG_DUNNING,
          status: "past_due",
          stripe_subscription_id: "sub_dunning_1",
        },
      ])
      .execute();
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("rejects an org with an active subscription", async () => {
    await expect(
      ORGANIZATION_BILLING_CHECKOUT_START.handler(
        {},
        makeCtx(database, ORG_ACTIVE),
      ),
    ).rejects.toThrow(/already has an active subscription/);
  });

  it("rejects a BOUND subscription even when not active — no second paid subscription", async () => {
    // past_due = a live Stripe subscription still exists; a second checkout
    // would charge for one the webhook then refuses to bind.
    await expect(
      ORGANIZATION_BILLING_CHECKOUT_START.handler(
        {},
        makeCtx(database, ORG_DUNNING),
      ),
    ).rejects.toThrow(/subscription on file/);
  });
});
