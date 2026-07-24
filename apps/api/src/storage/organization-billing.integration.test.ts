import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import {
  OrganizationBillingStorage,
  SeatTargetNotMemberError,
} from "./organization-billing";

// Real-Postgres coverage for the seat transaction: paid-seat rows and their
// change-log entries must commit together (the log is the invoiced orgs'
// billing source), no-ops must not log, and unknown users must reject the
// whole batch.
const ORG = "org_billing_1";

describe("OrganizationBillingStorage", () => {
  let database: StudioDatabase;
  let storage: OrganizationBillingStorage;

  // Raw SQL like seedCommonTestPgFixtures: real Postgres has BOOLEAN
  // emailVerified, which the (PGlite-era) typed table shape disagrees with.
  const addMember = async (userId: string) => {
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${userId}, ${`${userId}@billing.test`}, false, ${userId}, ${now}, ${now})
    `.execute(database.db);
    await sql`
      INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
      VALUES (${`mem_${userId}`}, ${userId}, ${ORG}, 'user', ${now})
    `.execute(database.db);
  };

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
      .values({ organization_id: ORG, legacy: false })
      .execute();
    await addMember("user_a");
    await addMember("user_b");
    storage = new OrganizationBillingStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("applies transitions and logs exactly the ones that changed state", async () => {
    const first = await storage.setSeats(
      ORG,
      [
        { userId: "user_a", seat: "paid" },
        { userId: "user_b", seat: "free" }, // already free — no-op
      ],
      "admin_1",
    );
    expect(first.applied).toEqual([{ userId: "user_a", seat: "paid" }]);
    expect(first.paidSeatCount).toBe(1);

    // Replaying the same state applies (and logs) nothing.
    const replay = await storage.setSeats(
      ORG,
      [{ userId: "user_a", seat: "paid" }],
      "admin_1",
    );
    expect(replay.applied).toEqual([]);
    expect(replay.paidSeatCount).toBe(1);

    const log = await database.db
      .selectFrom("seat_change_log")
      .select(["user_id", "seat", "changed_by"])
      .where("organization_id", "=", ORG)
      .execute();
    expect(log).toEqual([
      { user_id: "user_a", seat: "paid", changed_by: "admin_1" },
    ]);
  });

  it("rejects the whole batch when any target is not a member", async () => {
    await expect(
      storage.setSeats(
        ORG,
        [
          { userId: "user_b", seat: "paid" },
          { userId: "ghost", seat: "paid" },
        ],
        "admin_1",
      ),
    ).rejects.toThrow(SeatTargetNotMemberError);

    // Atomicity: the valid half of the batch must NOT have been applied.
    expect(await storage.listPaidSeatUserIds(ORG)).toEqual(["user_a"]);
  });

  it("a stale seat row (member gone, release never ran) never counts", async () => {
    // Simulate the crash window: member removed, releaseSeat never ran.
    await database.db
      .deleteFrom("member")
      .where("userId", "=", "user_a")
      .where("organizationId", "=", ORG)
      .execute();

    // The orphan row still exists…
    const raw = await database.db
      .selectFrom("organization_paid_seat")
      .select(["user_id"])
      .where("organization_id", "=", ORG)
      .execute();
    expect(raw.map((r) => r.user_id)).toEqual(["user_a"]);
    // …but the member JOIN keeps it out of every count.
    expect(await storage.listPaidSeatUserIds(ORG)).toEqual([]);
  });

  it("releases the seat (hooks boundary), logs it, and marks the sync pending", async () => {
    const release = await storage.releaseSeat(ORG, "user_a", "admin_1", {
      markBenefitsPending: true,
    });
    expect(release.released).toBe(true);
    expect(release.benefitsReferenceId).toBeTruthy();
    expect(await storage.listPaidSeatUserIds(ORG)).toEqual([]);
    // The pending marker committed with the release (same transaction).
    expect((await storage.getBilling(ORG))?.benefitsReferenceId).toBe(
      release.benefitsReferenceId,
    );

    // Releasing again is a no-op — nothing new logged, no new marker.
    const again = await storage.releaseSeat(ORG, "user_a", "admin_1", {
      markBenefitsPending: true,
    });
    expect(again.released).toBe(false);
    expect(again.benefitsReferenceId).toBeNull();

    const frees = await database.db
      .selectFrom("seat_change_log")
      .select(["seat"])
      .where("organization_id", "=", ORG)
      .where("user_id", "=", "user_a")
      .execute();
    expect(frees.map((r) => r.seat)).toEqual(["paid", "free"]);
  });

  it("clearBenefitsPending is a CAS: only the matching reference clears", async () => {
    const pendingRef = (await storage.getBilling(ORG))?.benefitsReferenceId;
    expect(pendingRef).toBeTruthy();

    // A stale delivery (older reference) must NOT clear the newer marker.
    await storage.clearBenefitsPending(ORG, "some-older-reference");
    expect((await storage.getBilling(ORG))?.benefitsReferenceId).toBe(
      pendingRef ?? null,
    );

    // The sweep sees it once stale…
    const pending = await storage.listBenefitsPending(
      new Date(Date.now() + 60_000),
      10,
    );
    expect(pending).toEqual([
      { organizationId: ORG, referenceId: pendingRef as string },
    ]);

    // …and the matching delivery clears it.
    await storage.clearBenefitsPending(ORG, pendingRef as string);
    expect((await storage.getBilling(ORG))?.benefitsReferenceId).toBeNull();
    expect(
      await storage.listBenefitsPending(new Date(Date.now() + 60_000), 10),
    ).toEqual([]);
  });

  it("getBilling maps the row; missing row is null (fail-open upstream)", async () => {
    const billing = await storage.getBilling(ORG);
    expect(billing?.legacy).toBe(false);
    expect(billing?.billingMode).toBe("self_serve");
    expect(billing?.status).toBe("none");
    expect(await storage.getBilling("org_without_billing")).toBeNull();
  });
});
