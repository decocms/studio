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

  it("enforces the unique constraint on (run_id, seq)", async () => {
    const now = new Date().toISOString();
    const threadId = "thr_test_098";
    const runId = "run_test_098";

    // Insert a minimal thread row required by the FK on thread_id
    await sql`
      INSERT INTO threads (id, organization_id, created_by, title, status, created_at, updated_at)
      VALUES (${threadId}, 'org_test', 'user_test', 'Test', 'idle', ${now}, ${now})
    `.execute(database.db);

    const part = {
      id: `${runId}:1`,
      seq: 1,
      org_id: "org_test",
      thread_id: threadId,
      run_id: runId,
      message_id: "msg_1",
      role: "assistant",
      kind: "text",
      payload: JSON.stringify({ text: "hello" }),
      created_at: now,
    };

    await sql`
      INSERT INTO thread_message_parts
        (id, seq, org_id, thread_id, run_id, message_id, role, kind, payload, created_at)
      VALUES
        (${part.id}, ${part.seq}, ${part.org_id}, ${part.thread_id}, ${part.run_id},
         ${part.message_id}, ${part.role}, ${part.kind}, ${part.payload}::jsonb, ${part.created_at})
    `.execute(database.db);

    // Inserting a duplicate (run_id, seq) must fail
    await expect(
      sql`
        INSERT INTO thread_message_parts
          (id, seq, org_id, thread_id, run_id, message_id, role, kind, payload, created_at)
        VALUES
          (${"run_test_098:1_dup"}, ${1}, ${"org_test"}, ${threadId}, ${runId},
           ${"msg_2"}, ${"assistant"}, ${"text"}, ${"{}"}::jsonb, ${now})
      `.execute(database.db),
    ).rejects.toThrow();
  });
});
