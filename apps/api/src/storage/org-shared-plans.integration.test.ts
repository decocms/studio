import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
} from "../database/test-db-pg";
import { OrgSharedPlanStorage } from "./org-shared-plans";

const PROVIDER = "github-copilot";

describe("OrgSharedPlanStorage.shareExclusive (real Postgres)", () => {
  let database: StudioDatabase;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
  });

  afterAll(async () => {
    if (database) await closeTestPgDatabase(database);
  });

  /** A fresh org with two members, named so `holder` can report them. */
  async function org() {
    const id = `org_${crypto.randomUUID()}`;
    const first = `user_${crypto.randomUUID()}`;
    const second = `user_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "organization" (id, name, slug, "createdAt")
      VALUES (${id}, ${id}, ${id}, ${now})
    `.execute(database.db);
    for (const [userId, name] of [
      [first, "First"],
      [second, "Second"],
    ] as const) {
      await sql`
        INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
        VALUES (${userId}, ${`${userId}@example.com`}, false, ${name}, ${now}, ${now})
      `.execute(database.db);
      await sql`
        INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
        VALUES (${crypto.randomUUID()}, ${userId}, ${id}, 'member', ${now})
      `.execute(database.db);
    }
    return {
      id,
      first,
      second,
      storage: new OrgSharedPlanStorage(database.db),
    };
  }

  test("the first sharer holds the slot; a second member is refused", async () => {
    const o = await org();
    expect(
      (await o.storage.shareExclusive(o.id, PROVIDER, o.first))?.userId,
    ).toBe(o.first);
    const refused = await o.storage.shareExclusive(o.id, PROVIDER, o.second);
    expect(refused).toMatchObject({ userId: o.first, userName: "First" });
    expect((await o.storage.list(o.id)).map((plan) => plan.userId)).toEqual([
      o.first,
    ]);
  });

  test("re-sharing your own share keeps one row", async () => {
    const o = await org();
    await o.storage.shareExclusive(o.id, PROVIDER, o.first);
    await o.storage.shareExclusive(o.id, PROVIDER, o.first);
    expect(await o.storage.list(o.id)).toHaveLength(1);
  });

  test("two members sharing at once leave exactly one share", async () => {
    const o = await org();
    const [a, b] = await Promise.all([
      o.storage.shareExclusive(o.id, PROVIDER, o.first),
      o.storage.shareExclusive(o.id, PROVIDER, o.second),
    ]);
    const rows = await o.storage.list(o.id);
    expect(rows).toHaveLength(1);
    // Both callers are told the same winner.
    expect(a?.userId).toBe(rows[0]?.userId);
    expect(b?.userId).toBe(rows[0]?.userId);
  });

  test("an org with pre-existing duplicate shares reports the oldest", async () => {
    const o = await org();
    await sql`
      INSERT INTO org_shared_plans (organization_id, provider_id, user_id, created_at)
      VALUES
        (${o.id}, ${PROVIDER}, ${o.second}, ${"2026-01-02T00:00:00Z"}),
        (${o.id}, ${PROVIDER}, ${o.first}, ${"2026-01-01T00:00:00Z"})
    `.execute(database.db);
    expect((await o.storage.holder(o.id, PROVIDER))?.userId).toBe(o.first);
  });
});
