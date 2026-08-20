import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { TaskBoardStorage } from "./task-board";

/**
 * Real-Postgres coverage for the per-org card key (`DECO-01`).
 *
 * The allocator reads `max(key_seq)` inside the INSERT and leans on a unique
 * index to catch the race, so an in-memory fake proves nothing: what's under
 * test is exactly what Postgres does when two inserts read the same max.
 */
const ORG = "org_key_seq_1";
const OTHER_ORG = "org_key_seq_2";
const USER = "user_key_seq";

describe("TaskBoardStorage — per-org key_seq", () => {
  let database: StudioDatabase;
  let storage: TaskBoardStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const createdAt = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${`${USER}@test.com`}, false, 'Key Seq', ${createdAt}, ${createdAt})
    `.execute(database.db);
    for (const [id, slug] of [
      [ORG, "key-seq-one"],
      [OTHER_ORG, "key-seq-two"],
    ] as const) {
      await database.db
        .insertInto("organization")
        .values({ id, name: id, slug, createdAt })
        .execute();
    }
    storage = new TaskBoardStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  const create = (organizationId: string, title: string) =>
    storage.create({ organizationId, title, by: USER });

  it("numbers cards from 1, in creation order", async () => {
    const first = await create(ORG, "First");
    const second = await create(ORG, "Second");
    const third = await create(ORG, "Third");
    expect([first.keySeq, second.keySeq, third.keySeq]).toEqual([1, 2, 3]);
  });

  it("numbers each org independently", async () => {
    const other = await create(OTHER_ORG, "Other org's first");
    expect(other.keySeq).toBe(1);
  });

  it("gives concurrent creates distinct numbers", async () => {
    // Well past the contention that broke a retry-on-conflict allocator: the
    // advisory lock has to hold under a burst, not merely usually.
    const burst = 24;
    const created = await Promise.all(
      Array.from({ length: burst }, (_, i) => create(ORG, `Concurrent ${i}`)),
    );
    const seqs = created.map((item) => item.keySeq);
    expect(new Set(seqs).size).toBe(burst);
    // The org had 3 cards; the burst continues that run without a gap.
    expect([...seqs].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
      Array.from({ length: burst }, (_, i) => i + 4),
    );
  });

  it("reads the number back on list and getById", async () => {
    const items = await storage.list(ORG);
    expect(items.every((item) => item.keySeq !== null)).toBe(true);
    const first = items.find((item) => item.title === "First");
    expect(first?.keySeq).toBe(1);
    const byId = await storage.getById(first!.id, ORG);
    expect(byId?.keySeq).toBe(1);
  });
});
