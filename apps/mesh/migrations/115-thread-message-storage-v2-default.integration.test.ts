import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sql, type Kysely } from "kysely";
import type { StudioDatabase } from "../src/database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../src/database/test-db-pg";
import { up as up115 } from "./115-thread-message-storage-v2-default";

describe("migration 115 thread message storage v2 default", () => {
  let database: StudioDatabase;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
  });

  it("promotes empty legacy v1 threads but keeps legacy threads with messages on v1", async () => {
    const now = new Date().toISOString();

    await sql`
      INSERT INTO threads
        (id, organization_id, created_by, title, status, created_at, updated_at, message_storage_version)
      VALUES
        ('thrd_empty_v1', 'org_1', 'user_1', 'Empty v1', 'idle', ${now}, ${now}, 1),
        ('thrd_with_legacy_messages', 'org_1', 'user_1', 'Legacy v1', 'idle', ${now}, ${now}, 1)
    `.execute(database.db);

    await sql`
      INSERT INTO thread_messages
        (id, thread_id, metadata, parts, role, created_at, updated_at)
      VALUES
        ('msg_legacy', 'thrd_with_legacy_messages', '{}', '[]', 'assistant', ${now}, ${now})
    `.execute(database.db);

    await up115(database.db as unknown as Kysely<unknown>);

    const rows = await database.db
      .selectFrom("threads")
      .select(["id", "message_storage_version"])
      .where("id", "in", ["thrd_empty_v1", "thrd_with_legacy_messages"])
      .orderBy("id")
      .execute();

    expect(rows).toEqual([
      { id: "thrd_empty_v1", message_storage_version: 2 },
      { id: "thrd_with_legacy_messages", message_storage_version: 1 },
    ]);
  });
});
