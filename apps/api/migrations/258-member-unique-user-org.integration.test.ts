/**
 * Migration 258 keeps one membership row per user and organization.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../src/database/test-db-pg";
import type { StudioDatabase } from "../src/database";
import { down, up } from "./258-member-unique-user-org";

describe("migration 258 — unique member per user and org", () => {
  let database: StudioDatabase;

  // biome-ignore lint/suspicious/noExplicitAny: migrations accept the test Kysely instance
  const db = () => database.db as any;

  async function addMember(id: string, userId: string, createdAt: string) {
    await sql`
      INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
      VALUES (${id}, 'org_1', ${userId}, 'admin', ${createdAt})
    `.execute(database.db);
  }

  async function memberIds(): Promise<string[]> {
    const rows = await database.db
      .selectFrom("member")
      .select("id")
      .orderBy("id")
      .execute();
    return rows.map((row) => row.id);
  }

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    await down(db());
  });

  afterEach(async () => {
    await up(db());
    await closeTestPgDatabase(database);
  });

  it("keeps the oldest row of a duplicated membership", async () => {
    await addMember("mem_later", "user_1", "2026-01-02T00:00:00.000Z");
    await addMember("mem_first", "user_1", "2026-01-01T00:00:00.000Z");
    await addMember("mem_other", "user_123", "2026-01-03T00:00:00.000Z");

    await up(db());

    expect(await memberIds()).toEqual(["mem_first", "mem_other"]);
  });

  it("rejects a second membership for the same user and org", async () => {
    await up(db());
    await addMember("mem_first", "user_1", "2026-01-01T00:00:00.000Z");

    await expect(
      addMember("mem_again", "user_1", "2026-01-02T00:00:00.000Z"),
    ).rejects.toThrow(/idx_member_user_org_unique/);
  });
});
