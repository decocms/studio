import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { OrganizationBillingStorage } from "../storage/organization-billing";
import { ReportsClientError } from "./reports-client";
import { executeReportScheduleSync } from "./sync-org-benefits";

// Real-Postgres coverage for the syncReportSchedule EXECUTION path — the
// load-bearing behaviors the pure planner can't see: disarm-before-arm
// ordering, permanent-4xx handling (arm failure clears armed_report_url and
// does NOT throw; disarm failure proceeds), 5xx propagation (retriable), the
// in-step pending-ref re-check, and zero calls once converged. The reports
// HTTP boundary is injected (recording/failing fake) while storage is real.
const ORG = "org_benefits_1";

type Call = { host: string; enabled: boolean };

function recorder(failWith?: { onEnabled: boolean; error: Error }) {
  const calls: Call[] = [];
  return {
    calls,
    schedule: async (input: {
      host: string;
      organizationId: string;
      enabled: boolean;
    }) => {
      calls.push({ host: input.host, enabled: input.enabled });
      if (failWith && input.enabled === failWith.onEnabled) {
        throw failWith.error;
      }
    },
  };
}

describe("executeReportScheduleSync", () => {
  let database: StudioDatabase;
  let storage: OrganizationBillingStorage;

  const deps = (fake: ReturnType<typeof recorder>) => ({
    storage: () => storage,
    schedule: fake.schedule,
    configured: () => true,
  });

  const setState = async (state: {
    referenceId: string | null;
    included: string | null;
    armed: string | null;
  }) => {
    await database.db
      .updateTable("organization_billing")
      .set({
        benefits_reference_id: state.referenceId,
        included_report_url: state.included,
        armed_report_url: state.armed,
      })
      .where("organization_id", "=", ORG)
      .execute();
  };

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    await database.db
      .insertInto("organization")
      .values({ id: ORG, name: ORG, slug: ORG, createdAt: now })
      .execute();
    // invoiced: seats count without any Stripe status.
    await database.db
      .insertInto("organization_billing")
      .values({
        organization_id: ORG,
        legacy: false,
        billing_mode: "invoiced",
      })
      .execute();
    await database.db
      .insertInto("user")
      .values({
        id: "user_b1",
        email: "b1@benefits.test",
        emailVerified: 1,
        name: "b1",
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    await database.db
      .insertInto("member")
      .values({
        id: "mem_b1",
        userId: "user_b1",
        organizationId: ORG,
        role: "user",
        createdAt: now,
      })
      .execute();
    await database.db
      .insertInto("organization_paid_seat")
      .values({ organization_id: ORG, user_id: "user_b1" })
      .execute();
    storage = new OrganizationBillingStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("choice change disarms the OLD site before arming the new one", async () => {
    await setState({ referenceId: "ref_1", included: "b.com", armed: "a.com" });
    const fake = recorder();

    await executeReportScheduleSync(ORG, "ref_1", deps(fake));

    expect(fake.calls).toEqual([
      { host: "a.com", enabled: false },
      { host: "b.com", enabled: true },
    ]);
    expect((await storage.getBilling(ORG))?.armedReportUrl).toBe("b.com");
  });

  it("converged state makes zero calls", async () => {
    await setState({ referenceId: "ref_2", included: "b.com", armed: "b.com" });
    const fake = recorder();
    await executeReportScheduleSync(ORG, "ref_2", deps(fake));
    expect(fake.calls).toEqual([]);
  });

  it("superseded pending ref makes zero calls (newer workflow owns it)", async () => {
    await setState({
      referenceId: "ref_newer",
      included: "c.com",
      armed: "b.com",
    });
    const fake = recorder();
    await executeReportScheduleSync(ORG, "ref_old", deps(fake));
    expect(fake.calls).toEqual([]);
    expect((await storage.getBilling(ORG))?.armedReportUrl).toBe("b.com");
  });

  it("permanent 4xx on ARM clears armed_report_url and does not throw", async () => {
    await setState({ referenceId: "ref_3", included: "bad.com", armed: null });
    const fake = recorder({
      onEnabled: true,
      error: new ReportsClientError(409, "not owner"),
    });

    await executeReportScheduleSync(ORG, "ref_3", deps(fake));

    expect(fake.calls).toEqual([{ host: "bad.com", enabled: true }]);
    // Nothing armed recorded — the next choice change re-attempts.
    expect((await storage.getBilling(ORG))?.armedReportUrl).toBeNull();
  });

  it("permanent 4xx on DISARM proceeds (schedule already gone over there)", async () => {
    await setState({
      referenceId: "ref_4",
      included: "d.com",
      armed: "gone.com",
    });
    const fake = recorder({
      onEnabled: false,
      error: new ReportsClientError(404, "unknown host"),
    });

    await executeReportScheduleSync(ORG, "ref_4", deps(fake));

    // Disarm failed permanently → treated as disarmed; arm still happened.
    expect(fake.calls).toEqual([
      { host: "gone.com", enabled: false },
      { host: "d.com", enabled: true },
    ]);
    expect((await storage.getBilling(ORG))?.armedReportUrl).toBe("d.com");
  });

  it("5xx throws (retriable by the durable step) and records nothing", async () => {
    await setState({ referenceId: "ref_5", included: "e.com", armed: "d.com" });
    const fake = recorder({
      onEnabled: true,
      error: new ReportsClientError(503, "reports down"),
    });

    await expect(
      executeReportScheduleSync(ORG, "ref_5", deps(fake)),
    ).rejects.toThrow("reports down");
    // armed_report_url untouched — the retry re-plans from live state.
    expect((await storage.getBilling(ORG))?.armedReportUrl).toBe("d.com");
  });

  it("zero effective seats disarms and arms nothing", async () => {
    await setState({ referenceId: "ref_6", included: "e.com", armed: "d.com" });
    await database.db
      .deleteFrom("organization_paid_seat")
      .where("organization_id", "=", ORG)
      .execute();
    const fake = recorder();

    await executeReportScheduleSync(ORG, "ref_6", deps(fake));

    expect(fake.calls).toEqual([{ host: "d.com", enabled: false }]);
    expect((await storage.getBilling(ORG))?.armedReportUrl).toBeNull();
  });
});
