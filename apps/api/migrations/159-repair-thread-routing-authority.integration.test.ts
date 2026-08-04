import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql, type Kysely } from "kysely";
import type { StudioDatabase } from "../src/database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../src/database/test-db-pg";
import { SqlThreadStorage } from "../src/storage/threads";
import { down, up } from "./159-repair-thread-routing-authority";

describe("migration 159: repair thread routing authority", () => {
  let database: StudioDatabase;
  let migrationDb: Kysely<unknown>;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    migrationDb = database.db as unknown as Kysely<unknown>;

    // CI applies every migration before integration tests start. Remove the
    // compatibility trigger so the first fixtures really model rows written
    // after migration 158 but before migration 159.
    await down(migrationDb);
  });

  afterAll(async () => {
    if (database) {
      // Restore production schema state even when the assertion path stopped
      // after the explicit down() below.
      await up(migrationDb);
      await closeTestPgDatabase(database);
    }
  });

  it("repairs late pre-expand writes before selector-free readers switch", async () => {
    const storage = new SqlThreadStorage(database.db);
    for (const id of [
      "thrd_159_pristine",
      "thrd_159_canonical",
      "thrd_159_partial",
      "thrd_159_native",
      "thrd_159_in_progress",
    ]) {
      await storage.create({
        id,
        organization_id: "org_1",
        created_by: "user_1",
        title: id,
      });
    }

    // Simulate writes from a pod that predates migration 158. These happen
    // after the expand migration's first pass, so only migration 159 sees them.
    await sql`
      UPDATE threads
      SET harness_id = 'decopilot',
          sandbox_provider_kind = 'agent-sandbox'
      WHERE id = 'thrd_159_canonical'
    `.execute(database.db);
    await sql`
      UPDATE threads
      SET sandbox_provider_kind = 'agent-sandbox'
      WHERE id = 'thrd_159_partial'
    `.execute(database.db);
    await sql`
      UPDATE threads
      SET harness_id = 'codex',
          sandbox_provider_kind = 'user-desktop'
      WHERE id = 'thrd_159_native'
    `.execute(database.db);
    await sql`
      UPDATE threads
      SET status = 'in_progress'
      WHERE id = 'thrd_159_in_progress'
    `.execute(database.db);

    await up(migrationDb);

    for (const id of [
      "thrd_159_trigger_canonical",
      "thrd_159_trigger_native",
    ]) {
      await storage.create({
        id,
        organization_id: "org_1",
        created_by: "user_1",
        title: id,
      });
    }
    // These writes occur after the repair sweep, as they would from an old pod
    // overlapping the switch rollout. The trigger must close that window.
    await sql`
      UPDATE threads
      SET harness_id = 'decopilot',
          sandbox_provider_kind = 'agent-sandbox'
      WHERE id = 'thrd_159_trigger_canonical'
    `.execute(database.db);
    await sql`
      UPDATE threads
      SET harness_id = 'codex',
          sandbox_provider_kind = 'user-desktop'
      WHERE id = 'thrd_159_trigger_native'
    `.execute(database.db);
    await sql`
      INSERT INTO threads (
        id,
        organization_id,
        title,
        created_by,
        harness_id,
        sandbox_provider_kind
      ) VALUES (
        'thrd_159_trigger_insert',
        'org_1',
        'thrd_159_trigger_insert',
        'user_1',
        'decopilot',
        'agent-sandbox'
      )
    `.execute(database.db);

    // Selector-era writers can neither clear the durable lock, erase the
    // canonical compatibility tuple, nor revive a tombstoned runtime.
    await sql`
      UPDATE threads
      SET routing_locked_at = NULL,
          harness_id = NULL,
          sandbox_provider_kind = NULL
      WHERE id = 'thrd_159_trigger_canonical'
    `.execute(database.db);
    await sql`
      UPDATE threads
      SET hosted_execution_disabled_at = NULL
      WHERE id = 'thrd_159_trigger_native'
    `.execute(database.db);

    const rows = await sql<{
      id: string;
      harness_id: string | null;
      sandbox_provider_kind: string | null;
      routing_locked_at: Date | null;
      hosted_execution_disabled_at: Date | null;
    }>`
      SELECT id,
             harness_id,
             sandbox_provider_kind,
             routing_locked_at,
             hosted_execution_disabled_at
      FROM threads
      WHERE id LIKE 'thrd_159_%'
      ORDER BY id COLLATE "C"
    `.execute(database.db);

    expect(rows.rows).toEqual([
      {
        id: "thrd_159_canonical",
        harness_id: "decopilot",
        sandbox_provider_kind: "agent-sandbox",
        routing_locked_at: expect.any(Date),
        hosted_execution_disabled_at: null,
      },
      {
        id: "thrd_159_in_progress",
        harness_id: "decopilot",
        sandbox_provider_kind: "agent-sandbox",
        routing_locked_at: expect.any(Date),
        hosted_execution_disabled_at: null,
      },
      {
        id: "thrd_159_native",
        harness_id: "codex",
        sandbox_provider_kind: "user-desktop",
        routing_locked_at: expect.any(Date),
        hosted_execution_disabled_at: expect.any(Date),
      },
      {
        id: "thrd_159_partial",
        harness_id: "decopilot",
        sandbox_provider_kind: "agent-sandbox",
        routing_locked_at: expect.any(Date),
        hosted_execution_disabled_at: null,
      },
      {
        id: "thrd_159_pristine",
        harness_id: null,
        sandbox_provider_kind: null,
        routing_locked_at: null,
        hosted_execution_disabled_at: null,
      },
      {
        id: "thrd_159_trigger_canonical",
        harness_id: "decopilot",
        sandbox_provider_kind: "agent-sandbox",
        routing_locked_at: expect.any(Date),
        hosted_execution_disabled_at: null,
      },
      {
        id: "thrd_159_trigger_insert",
        harness_id: "decopilot",
        sandbox_provider_kind: "agent-sandbox",
        routing_locked_at: expect.any(Date),
        hosted_execution_disabled_at: null,
      },
      {
        id: "thrd_159_trigger_native",
        harness_id: "codex",
        sandbox_provider_kind: "user-desktop",
        routing_locked_at: expect.any(Date),
        hosted_execution_disabled_at: expect.any(Date),
      },
    ]);

    const firstAuthority = rows.rows.map((row) => ({
      id: row.id,
      routing_locked_at: row.routing_locked_at,
      hosted_execution_disabled_at: row.hosted_execution_disabled_at,
    }));
    await up(migrationDb);
    await down(migrationDb);
    const secondAuthority = await sql<{
      id: string;
      routing_locked_at: Date | null;
      hosted_execution_disabled_at: Date | null;
    }>`
      SELECT id, routing_locked_at, hosted_execution_disabled_at
      FROM threads
      WHERE id LIKE 'thrd_159_%'
      ORDER BY id COLLATE "C"
    `.execute(database.db);
    expect(secondAuthority.rows).toEqual(firstAuthority);
  });
});
