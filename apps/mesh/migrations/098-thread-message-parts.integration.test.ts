/**
 * Integration test for migration 098: thread_message_parts table + new
 * columns on threads.
 *
 * Verifies the table is created with the expected columns and that the
 * `message_storage_version` column (with default 1) and `last_progress_at`
 * are added to `threads`.
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

describe("migration 098 thread_message_parts", () => {
  let database: StudioDatabase;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
  });

  it("creates the table with the expected columns", async () => {
    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'thread_message_parts'
    `.execute(database.db);
    const names = cols.rows.map((r) => r.column_name);
    expect(names).toContain("id");
    expect(names).toContain("seq");
    expect(names).toContain("org_id");
    expect(names).toContain("thread_id");
    expect(names).toContain("run_id");
    expect(names).toContain("message_id");
    expect(names).toContain("role");
    expect(names).toContain("kind");
    expect(names).toContain("payload");
    expect(names).toContain("payload_ref");
    expect(names).toContain("metadata");
    expect(names).toContain("created_at");
  });

  it("adds message_storage_version defaulting to 1 on threads", async () => {
    const cols = await sql<{ column_default: string | null }>`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'threads' AND column_name = 'message_storage_version'
    `.execute(database.db);
    expect(cols.rows[0]?.column_default).toContain("1");
  });

  it("adds last_progress_at column to threads", async () => {
    const cols = await sql<{ column_name: string; data_type: string }>`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'threads' AND column_name = 'last_progress_at'
    `.execute(database.db);
    expect(cols.rows).toHaveLength(1);
    expect(cols.rows[0]?.data_type).toBe("timestamp with time zone");
  });

  it("allows the same (run_id, seq) across messages but rejects duplicate ids", async () => {
    // Migration 106 dropped the old UNIQUE(run_id, seq) index: part ids are now
    // `${runId}:${messageId}:${seq}` and `seq` is per-MESSAGE (restarts at 0 per
    // message), so two messages in one run legitimately share (run_id, seq) —
    // e.g. the user message (persisted at dispatch) and the assistant message
    // (persisted at relay). Row uniqueness is guaranteed by the `id` primary
    // key instead.
    const now = new Date().toISOString();
    const threadId = "thr_test_098";
    const runId = "run_test_098";

    // Insert a minimal thread row required by the FK on thread_id
    await sql`
      INSERT INTO threads (id, organization_id, created_by, title, status, created_at, updated_at)
      VALUES (${threadId}, 'org_test', 'user_test', 'Test', 'idle', ${now}, ${now})
    `.execute(database.db);

    const insertPart = (id: string, seq: number, messageId: string) =>
      sql`
        INSERT INTO thread_message_parts
          (id, seq, org_id, thread_id, run_id, message_id, role, kind, payload, created_at)
        VALUES
          (${id}, ${seq}, ${"org_test"}, ${threadId}, ${runId},
           ${messageId}, ${"assistant"}, ${"text"}, ${"{}"}::jsonb, ${now})
      `.execute(database.db);

    // First message's part at seq 1.
    await insertPart(`${runId}:msg_1:1`, 1, "msg_1");

    // A DIFFERENT message reusing (run_id, seq)=(runId, 1) is now allowed — the
    // old UNIQUE(run_id, seq) index would have rejected this.
    await insertPart(`${runId}:msg_2:1`, 1, "msg_2");

    // A duplicate `id` (the primary key) is still rejected.
    await expect(insertPart(`${runId}:msg_1:1`, 1, "msg_1")).rejects.toThrow();
  });
});
