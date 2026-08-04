import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type Kysely, sql } from "kysely";
import type { StudioDatabase } from "../src/database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../src/database/test-db-pg";
import { SqlThreadStorage } from "../src/storage/threads";
import { down, up } from "./158-thread-routing-lock";

const ROUTING_COLUMNS = [
  "routing_locked_at",
  "hosted_execution_disabled_at",
] as const;

async function routingColumns(database: StudioDatabase) {
  const result = await sql<{
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'threads'
      AND column_name IN (
        'routing_locked_at',
        'hosted_execution_disabled_at'
      )
    ORDER BY column_name
  `.execute(database.db);
  return result.rows;
}

describe("migration 158: thread routing lock", () => {
  let database: StudioDatabase;
  let migrationDb: Kysely<unknown>;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    migrationDb = database.db as unknown as Kysely<unknown>;

    // Recover cleanly if an interrupted local run stopped after `down`.
    if ((await routingColumns(database)).length === 0) {
      await up(migrationDb);
    }
  });

  afterAll(async () => {
    if (database) {
      if ((await routingColumns(database)).length === 0) {
        await up(migrationDb);
      }
      await closeTestPgDatabase(database);
    }
  });

  it("backfills authority and fails closed without locking pristine drafts", async () => {
    const storage = new SqlThreadStorage(database.db);
    const create = async (
      id: string,
      data: {
        status?: "completed" | "in_progress" | "requires_action" | "failed";
        harness_id?: string | null;
        sandbox_provider_kind?: string | null;
      } = {},
    ) => {
      await storage.create({
        id,
        organization_id: "org_1",
        created_by: "user_1",
        title: id,
        ...(data.status ? { status: data.status } : {}),
      });
      // Seed the pre-158 selector shapes beneath the current selector-free
      // create port. These are historical database fixtures, not supported
      // application inputs.
      await sql`
        UPDATE threads
        SET harness_id = ${data.harness_id ?? null},
            sandbox_provider_kind = ${data.sandbox_provider_kind ?? null}
        WHERE id = ${id}
          AND organization_id = 'org_1'
      `.execute(database.db);
    };

    await create("thrd_158_pristine");
    await create("thrd_158_canonical", {
      harness_id: "decopilot",
      sandbox_provider_kind: "agent-sandbox",
    });
    await create("thrd_158_claimable_partial", {
      sandbox_provider_kind: "agent-sandbox",
    });
    await create("thrd_158_native", {
      harness_id: "codex",
      sandbox_provider_kind: "user-desktop",
    });
    await create("thrd_158_incomplete", { harness_id: "decopilot" });
    await create("thrd_158_unknown_provider", {
      sandbox_provider_kind: "cluster",
    });
    await create("thrd_158_message_history");
    await create("thrd_158_part_history");
    await create("thrd_158_in_progress", { status: "in_progress" });
    await create("thrd_158_requires_action", { status: "requires_action" });
    await create("thrd_158_failed", { status: "failed" });
    await create("thrd_158_run_evidence");
    await storage.update("thrd_158_run_evidence", "org_1", {
      run_started_at: "2026-08-01T12:00:00.000Z",
    });

    const now = new Date().toISOString();
    await sql`
      INSERT INTO thread_messages (
        id, thread_id, metadata, parts, role, created_at, updated_at
      ) VALUES (
        'msg_158_history',
        'thrd_158_message_history',
        NULL,
        '[]',
        'user',
        ${now},
        ${now}
      )
    `.execute(database.db);
    await sql`
      INSERT INTO thread_message_parts (
        id, seq, org_id, thread_id, run_id, message_id, role, kind,
        payload, payload_ref, metadata, created_at
      ) VALUES (
        'part_158_history',
        1,
        'org_1',
        'thrd_158_part_history',
        'run_158_history',
        'msg_158_part_history',
        'user',
        'text',
        ${JSON.stringify({ type: "text", text: "started" })}::jsonb,
        NULL,
        NULL,
        ${now}
      )
    `.execute(database.db);

    // Re-run the migration over the seeded pre-158 state.
    await down(migrationDb);
    expect(await routingColumns(database)).toEqual([]);
    await up(migrationDb);

    expect(await routingColumns(database)).toEqual([
      {
        column_name: "hosted_execution_disabled_at",
        data_type: "timestamp with time zone",
        is_nullable: "YES",
      },
      {
        column_name: "routing_locked_at",
        data_type: "timestamp with time zone",
        is_nullable: "YES",
      },
    ]);

    const result = await sql<{
      id: string;
      harness_id: string | null;
      sandbox_provider_kind: string | null;
      routing_locked: boolean;
      hosted_disabled: boolean;
    }>`
      SELECT
        id,
        harness_id,
        sandbox_provider_kind,
        routing_locked_at IS NOT NULL AS routing_locked,
        hosted_execution_disabled_at IS NOT NULL AS hosted_disabled
      FROM threads
      WHERE id LIKE 'thrd_158_%'
      ORDER BY id COLLATE "C"
    `.execute(database.db);

    expect(result.rows).toEqual([
      {
        id: "thrd_158_canonical",
        harness_id: "decopilot",
        sandbox_provider_kind: "agent-sandbox",
        routing_locked: true,
        hosted_disabled: false,
      },
      {
        id: "thrd_158_claimable_partial",
        harness_id: "decopilot",
        sandbox_provider_kind: "agent-sandbox",
        routing_locked: true,
        hosted_disabled: false,
      },
      {
        id: "thrd_158_failed",
        harness_id: "decopilot",
        sandbox_provider_kind: "agent-sandbox",
        routing_locked: true,
        hosted_disabled: false,
      },
      {
        id: "thrd_158_in_progress",
        harness_id: "decopilot",
        sandbox_provider_kind: "agent-sandbox",
        routing_locked: true,
        hosted_disabled: false,
      },
      {
        id: "thrd_158_incomplete",
        harness_id: "decopilot",
        sandbox_provider_kind: null,
        routing_locked: true,
        hosted_disabled: true,
      },
      {
        id: "thrd_158_message_history",
        harness_id: "decopilot",
        sandbox_provider_kind: "agent-sandbox",
        routing_locked: true,
        hosted_disabled: false,
      },
      {
        id: "thrd_158_native",
        harness_id: "codex",
        sandbox_provider_kind: "user-desktop",
        routing_locked: true,
        hosted_disabled: true,
      },
      {
        id: "thrd_158_part_history",
        harness_id: "decopilot",
        sandbox_provider_kind: "agent-sandbox",
        routing_locked: true,
        hosted_disabled: false,
      },
      {
        id: "thrd_158_pristine",
        harness_id: null,
        sandbox_provider_kind: null,
        routing_locked: false,
        hosted_disabled: false,
      },
      {
        id: "thrd_158_requires_action",
        harness_id: "decopilot",
        sandbox_provider_kind: "agent-sandbox",
        routing_locked: true,
        hosted_disabled: false,
      },
      {
        id: "thrd_158_run_evidence",
        harness_id: "decopilot",
        sandbox_provider_kind: "agent-sandbox",
        routing_locked: true,
        hosted_disabled: false,
      },
      {
        id: "thrd_158_unknown_provider",
        harness_id: null,
        sandbox_provider_kind: "cluster",
        routing_locked: true,
        hosted_disabled: true,
      },
    ]);

    // The migration changes authority metadata only; adjacent history remains.
    const history = await sql<{ count: number }>`
      SELECT count(*)::integer AS count
      FROM thread_messages
      WHERE thread_id = 'thrd_158_message_history'
    `.execute(database.db);
    expect(history.rows).toEqual([{ count: 1 }]);

    await down(migrationDb);
    expect(await routingColumns(database)).toEqual([]);
    await up(migrationDb);
    expect(
      (await routingColumns(database)).map((row) => row.column_name),
    ).toEqual([...ROUTING_COLUMNS].sort());
  });
});
