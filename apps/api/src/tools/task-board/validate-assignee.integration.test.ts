import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../../database/test-db-pg";
import { assertValidAssignee } from "./validate-assignee";
import { SUPER_AGENT_ASSIGNEE_ID } from "./schema";

const ORG_ID = "org-assignee";
const OTHER_ORG_ID = "org-assignee-other";
const MEMBER_ID = "user-assignee-member";
const OUTSIDER_ID = "user-assignee-outsider";

describe("assertValidAssignee (real Postgres)", () => {
  let database: StudioDatabase;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);

    const now = new Date().toISOString();
    await sql`
      INSERT INTO "organization" (id, slug, name, "createdAt")
      VALUES (${ORG_ID}, 'assignee', 'Assignee', ${now}),
             (${OTHER_ORG_ID}, 'assignee-other', 'Other', ${now})
    `.execute(database.db);
    await sql`
      INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt")
      VALUES (${MEMBER_ID}, 'member@assignee.test', 'Member', false, ${now}, ${now}),
             (${OUTSIDER_ID}, 'outsider@assignee.test', 'Outsider', false, ${now}, ${now})
    `.execute(database.db);
    await sql`
      INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
      VALUES ('mem-assignee', ${MEMBER_ID}, ${ORG_ID}, 'user', ${now}),
             ('mem-assignee-other', ${OUTSIDER_ID}, ${OTHER_ORG_ID}, 'owner', ${now})
    `.execute(database.db);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
  });

  it("accepts a member of the organization", async () => {
    await expect(
      assertValidAssignee({ db: database.db }, ORG_ID, MEMBER_ID),
    ).resolves.toBeUndefined();
  });

  it("rejects a member of a different organization", async () => {
    await expect(
      assertValidAssignee({ db: database.db }, ORG_ID, OUTSIDER_ID),
    ).rejects.toThrow("assigneeId is not a member of the organization");
  });

  it("rejects an unknown user id", async () => {
    await expect(
      assertValidAssignee({ db: database.db }, ORG_ID, "user-missing"),
    ).rejects.toThrow("assigneeId is not a member of the organization");
  });

  it("accepts the Super Agent sentinel, which has no member row", async () => {
    await expect(
      assertValidAssignee({ db: database.db }, ORG_ID, SUPER_AGENT_ASSIGNEE_ID),
    ).resolves.toBeUndefined();
  });
});
