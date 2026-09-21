import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../../database/test-db-pg";
import type { StudioContext } from "../../core/studio-context";
import { ORGANIZATION_DELETE } from "./delete";

const ORG_ID = "org-doomed";
const USER_ID = "user-doomed";
const SESSION_ID = "sess-doomed";

function makeCtx(database: StudioDatabase): StudioContext {
  return {
    db: database.db,
    auth: { user: { id: USER_ID } },
    access: { check: async () => {} },
    organization: { id: ORG_ID, slug: "doomed", name: "Doomed" },
    boundAuth: {
      organization: {
        get: async () => ({ id: ORG_ID, metadata: {} }),
        update: async () => ({ id: ORG_ID }),
      },
    },
  } as unknown as StudioContext;
}

describe("ORGANIZATION_DELETE (real Postgres)", () => {
  let database: StudioDatabase;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);

    const now = new Date().toISOString();
    await sql`
      INSERT INTO "organization" (id, slug, name, "createdAt")
      VALUES (${ORG_ID}, 'doomed', 'Doomed', ${now})
    `.execute(database.db);
    await sql`
      INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt")
      VALUES (${USER_ID}, 'u@doomed.test', 'U', false, ${now}, ${now})
    `.execute(database.db);
    await sql`
      INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
      VALUES ('mem-doomed', ${USER_ID}, ${ORG_ID}, 'owner', ${now})
    `.execute(database.db);
    await sql`
      INSERT INTO "session" (id, "userId", token, "activeOrganizationId", "expiresAt", "createdAt", "updatedAt")
      VALUES (${SESSION_ID}, ${USER_ID}, 'tok-doomed', ${ORG_ID}, ${now}, ${now}, ${now})
    `.execute(database.db);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
  });

  it("clears activeOrganizationId on sessions pointing at the archived org", async () => {
    const ctx = makeCtx(database);

    await ORGANIZATION_DELETE.handler({ id: ORG_ID }, ctx);

    const row = await sql<{ activeOrganizationId: string | null }>`
      select "activeOrganizationId" from "session" where id = ${SESSION_ID}
    `.execute(database.db);
    expect(row.rows[0]?.activeOrganizationId).toBeNull();
  });
});
