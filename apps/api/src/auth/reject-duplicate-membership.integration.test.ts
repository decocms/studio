import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import type { StudioDatabase } from "../database";
import { isAlreadyMemberError } from "./is-already-member-error";
import { rejectDuplicateMembership } from "./reject-duplicate-membership";

const NOW = "2026-01-01T00:00:00.000Z";
const INVITATION = { id: "inv_1", organizationId: "org_1" };

describe("rejectDuplicateMembership", () => {
  let database: StudioDatabase;

  async function invitationStatus(): Promise<string | undefined> {
    const result = await sql<{ status: string }>`
      SELECT status FROM "invitation" WHERE id = ${INVITATION.id}
    `.execute(database.db);
    return result.rows[0]?.status;
  }

  beforeEach(async () => {
    database ??= await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    await sql`
      INSERT INTO "invitation"
        (id, "organizationId", email, role, status, "expiresAt", "inviterId")
      VALUES (${INVITATION.id}, ${INVITATION.organizationId},
        'invitee@example.com', 'admin', 'pending', '2099-01-01', 'user_123')
    `.execute(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("lets a user who is not yet a member accept", async () => {
    await rejectDuplicateMembership(database.db, INVITATION, "user_1");

    expect(await invitationStatus()).toBe("pending");
  });

  it("refuses an existing member and settles the invitation", async () => {
    await sql`
      INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
      VALUES ('mem_1', 'org_1', 'user_1', 'user', ${NOW})
    `.execute(database.db);

    const error = await rejectDuplicateMembership(
      database.db,
      INVITATION,
      "user_1",
    ).catch((err: unknown) => err);

    expect(isAlreadyMemberError(error)).toBe(true);
    expect(await invitationStatus()).toBe("accepted");
  });
});
