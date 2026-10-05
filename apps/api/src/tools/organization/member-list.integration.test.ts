import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../../database/test-db-pg";
import type { StudioContext } from "../../core/studio-context";
import { ORGANIZATION_MEMBER_LIST } from "./member-list";

const ORG_ID = "org-members";
const OTHER_ORG_ID = "org-members-other";

function makeCtx(database: StudioDatabase): StudioContext {
  return {
    db: database.db,
    auth: { user: { id: "user-a" } },
    access: { check: async () => {} },
    organization: { id: ORG_ID, slug: "members", name: "Members" },
  } as unknown as StudioContext;
}

describe("ORGANIZATION_MEMBER_LIST (real Postgres)", () => {
  let database: StudioDatabase;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);

    await sql`
      INSERT INTO "organization" (id, slug, name, "createdAt")
      VALUES (${ORG_ID}, 'members', 'Members', '2026-01-01T00:00:00.000Z'),
             (${OTHER_ORG_ID}, 'members-other', 'Other', '2026-01-01T00:00:00.000Z')
    `.execute(database.db);
    await sql`
      INSERT INTO "user" (id, email, name, image, "emailVerified", "createdAt", "updatedAt")
      VALUES ('user-a', 'a@members.test', 'Ada', 'https://example.test/a.png', false, now(), now()),
             ('user-b', 'b@members.test', 'Bea', NULL, false, now(), now()),
             ('user-c', 'c@members.test', 'Cy', NULL, false, now(), now())
    `.execute(database.db);
    await sql`
      INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
      VALUES ('mem-a', 'user-a', ${ORG_ID}, 'owner', '2026-01-01T00:00:00.000Z'),
             ('mem-b', 'user-b', ${ORG_ID}, 'user', '2026-01-02T00:00:00.000Z'),
             ('mem-c', 'user-c', ${OTHER_ORG_ID}, 'owner', '2026-01-01T00:00:00.000Z')
    `.execute(database.db);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
  });

  it("lists only the context organization's members, with their users", async () => {
    const { members } = await ORGANIZATION_MEMBER_LIST.handler(
      {},
      makeCtx(database),
    );

    expect(members).toEqual([
      {
        id: "mem-a",
        organizationId: ORG_ID,
        userId: "user-a",
        role: "owner",
        createdAt: "2026-01-01T00:00:00.000Z",
        user: {
          id: "user-a",
          name: "Ada",
          email: "a@members.test",
          image: "https://example.test/a.png",
        },
      },
      {
        id: "mem-b",
        organizationId: ORG_ID,
        userId: "user-b",
        role: "user",
        createdAt: "2026-01-02T00:00:00.000Z",
        user: {
          id: "user-b",
          name: "Bea",
          email: "b@members.test",
          image: undefined,
        },
      },
    ]);
    expect(
      ORGANIZATION_MEMBER_LIST.outputSchema.safeParse({ members }).success,
    ).toBe(true);
  });

  it("pages with limit and offset", async () => {
    const { members } = await ORGANIZATION_MEMBER_LIST.handler(
      { limit: 1, offset: 1 },
      makeCtx(database),
    );

    expect(members.map((m) => m.id)).toEqual(["mem-b"]);
  });
});
