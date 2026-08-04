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
import { down, up } from "./157-drop-thread-link-transport";

async function hasLinkTransportColumn(database: StudioDatabase) {
  const result = await sql<{ present: boolean }>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'threads'
        AND column_name = 'link_transport'
    ) AS present
  `.execute(database.db);
  return result.rows[0]?.present ?? false;
}

describe("migration 157: drop thread link transport", () => {
  let database: StudioDatabase;
  let migrationDb: Kysely<unknown>;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    migrationDb = database.db as unknown as Kysely<unknown>;

    // Recover cleanly if a previous interrupted local run left the test DB at
    // the migration's down state.
    if (await hasLinkTransportColumn(database)) {
      await up(migrationDb);
    }
  });

  afterAll(async () => {
    if (database) {
      if (await hasLinkTransportColumn(database)) {
        await up(migrationDb);
      }
      await closeTestPgDatabase(database);
    }
  });

  it("drops only link_transport and down restores the nullable column", async () => {
    await down(migrationDb);
    expect(await hasLinkTransportColumn(database)).toBe(true);

    const storage = new SqlThreadStorage(database.db);
    const thread = await storage.create({
      organization_id: "org_1",
      created_by: "user_1",
      title: "Adjacent data survives",
      status: "in_progress",
      routing_locked_at: "2026-08-04T12:00:00.000Z",
    });
    await sql`
      UPDATE threads
      SET link_transport = 'retired-desktop-link'
      WHERE id = ${thread.id}
    `.execute(database.db);

    await up(migrationDb);
    expect(await hasLinkTransportColumn(database)).toBe(false);

    const afterUp = await sql<{
      title: string;
      status: string;
      harness_id: string | null;
    }>`
      SELECT title, status, harness_id
      FROM threads
      WHERE id = ${thread.id}
    `.execute(database.db);
    expect(afterUp.rows).toEqual([
      {
        title: "Adjacent data survives",
        status: "in_progress",
        harness_id: "decopilot",
      },
    ]);

    await down(migrationDb);
    expect(await hasLinkTransportColumn(database)).toBe(true);
    const afterDown = await sql<{ link_transport: string | null }>`
      SELECT link_transport
      FROM threads
      WHERE id = ${thread.id}
    `.execute(database.db);
    expect(afterDown.rows).toEqual([{ link_transport: null }]);
  });
});
