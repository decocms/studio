/**
 * Integration test for migration 097: connection access + agent slots.
 *
 * Runs against the real-Postgres harness, where the schema is already
 * fully migrated (097 applied) before tests start. We therefore assert the
 * *resulting* schema behavior directly:
 *   1. New inserts that omit access get the post-migration default 'user'.
 *   2. CHECK constraint rejects access values other than 'user' / 'org'.
 *   3. Partial unique index R4: one user-private connection per (org, user, app_id).
 *   4. connection_aggregations XOR: a row carries a concrete child OR a slot,
 *      never both/neither.
 *   5. Partial unique index for slots: one slot per (agent, app_id).
 *
 * The backfill (existing rows → 'org') and `down` rollback paths exercised
 * the migrator's up/down mechanics against an ephemeral PGlite database.
 * They are intentionally omitted here: rolling the shared integration DB
 * down to 096 (or dropping the access column via `down`) would corrupt the
 * schema for every sibling `*.integration.test.ts` file that runs against
 * the same Postgres service. This mirrors the 087–092 migration tests,
 * which assert `up()` behavior only.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../src/database/test-db-pg";
import type { MeshDatabase } from "../src/database";

const USER_A = "user_test";
const USER_B = "user_1"; // both seeded by seedCommonTestPgFixtures
const ORG = "org_test";

interface ConnectionRow {
  id: string;
  access: string;
  app_id: string | null;
  created_by: string;
}

async function insertConnection(
  database: MeshDatabase,
  id: string,
  opts: {
    appId?: string | null;
    createdBy?: string;
    access?: string; // when omitted, DB default applies
  } = {},
): Promise<void> {
  const now = new Date().toISOString();
  const createdBy = opts.createdBy ?? USER_A;
  const appId = opts.appId ?? null;
  if (opts.access === undefined) {
    await sql`
      INSERT INTO connections (
        id, organization_id, created_by, title, connection_type,
        connection_url, app_id, status, created_at, updated_at
      ) VALUES (
        ${id}, ${ORG}, ${createdBy}, 'test', 'HTTP',
        'https://example.com', ${appId},
        'active', ${now}, ${now}
      )
    `.execute(database.db);
  } else {
    await sql`
      INSERT INTO connections (
        id, organization_id, created_by, title, connection_type,
        connection_url, app_id, access, status, created_at, updated_at
      ) VALUES (
        ${id}, ${ORG}, ${createdBy}, 'test', 'HTTP',
        'https://example.com', ${appId}, ${opts.access},
        'active', ${now}, ${now}
      )
    `.execute(database.db);
  }
}

async function insertVirtualParent(
  database: MeshDatabase,
  id: string,
): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO connections (
      id, organization_id, created_by, title, connection_type,
      connection_url, status, created_at, updated_at
    ) VALUES (
      ${id}, ${ORG}, ${USER_A}, 'agent', 'VIRTUAL',
      ${"virtual://" + id}, 'active', ${now}, ${now}
    )
  `.execute(database.db);
}

async function getAccess(database: MeshDatabase, id: string): Promise<string> {
  const result = (await sql<ConnectionRow>`
    SELECT id, access, app_id, created_by FROM connections WHERE id = ${id}
  `.execute(database.db)) as unknown as { rows: ConnectionRow[] };
  const row = result.rows[0];
  if (!row) throw new Error(`connection ${id} not found`);
  return row.access;
}

describe("migration 097 — connection access + slots", () => {
  let database: MeshDatabase;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
  });

  it("new inserts that omit access default to 'user'", async () => {
    await insertConnection(database, "conn_new");
    expect(await getAccess(database, "conn_new")).toBe("user");
  });

  it("CHECK rejects invalid access values", async () => {
    await expect(
      insertConnection(database, "conn_bad", { access: "public" }),
    ).rejects.toThrow();
  });

  it("R4: same user cannot have two user-private connections with same app_id", async () => {
    await insertConnection(database, "conn_gh1", {
      appId: "mcp-github",
      access: "user",
    });
    await expect(
      insertConnection(database, "conn_gh2", {
        appId: "mcp-github",
        access: "user",
      }),
    ).rejects.toThrow();
  });

  it("R4: org-shared connections of same app_id are NOT restricted", async () => {
    await insertConnection(database, "conn_org1", {
      appId: "mcp-github",
      access: "org",
    });
    await insertConnection(database, "conn_org2", {
      appId: "mcp-github",
      access: "org",
    });
    expect(await getAccess(database, "conn_org2")).toBe("org");
  });

  it("R4: different users can each own a user-private connection of same app_id", async () => {
    await insertConnection(database, "conn_a", {
      appId: "mcp-github",
      createdBy: USER_A,
      access: "user",
    });
    await insertConnection(database, "conn_b", {
      appId: "mcp-github",
      createdBy: USER_B,
      access: "user",
    });
    expect(await getAccess(database, "conn_b")).toBe("user");
  });

  it("R4: user-private rows without app_id are exempt", async () => {
    await insertConnection(database, "conn_noapp1", {
      appId: null,
      access: "user",
    });
    await insertConnection(database, "conn_noapp2", {
      appId: null,
      access: "user",
    });
    expect(await getAccess(database, "conn_noapp2")).toBe("user");
  });

  it("aggregation XOR: row with both child_connection_id and slot_app_id is rejected", async () => {
    await insertVirtualParent(database, "agent_xor1");
    await insertConnection(database, "conn_child_xor", {
      appId: "mcp-github",
      access: "org",
    });
    const now = new Date().toISOString();
    await expect(
      sql`
        INSERT INTO connection_aggregations (
          id, parent_connection_id, child_connection_id, slot_app_id,
          dependency_mode, created_at
        ) VALUES (
          'agg_both', 'agent_xor1', 'conn_child_xor', 'mcp-github',
          'direct', ${now}
        )
      `.execute(database.db),
    ).rejects.toThrow();
  });

  it("aggregation XOR: row with neither child_connection_id nor slot_app_id is rejected", async () => {
    await insertVirtualParent(database, "agent_xor2");
    const now = new Date().toISOString();
    await expect(
      sql`
        INSERT INTO connection_aggregations (
          id, parent_connection_id, child_connection_id, slot_app_id,
          dependency_mode, created_at
        ) VALUES (
          'agg_none', 'agent_xor2', NULL, NULL,
          'direct', ${now}
        )
      `.execute(database.db),
    ).rejects.toThrow();
  });

  it("aggregation slot: row with slot_app_id and NULL child_connection_id is accepted", async () => {
    await insertVirtualParent(database, "agent_slot1");
    const now = new Date().toISOString();
    await sql`
      INSERT INTO connection_aggregations (
        id, parent_connection_id, child_connection_id, slot_app_id,
        dependency_mode, created_at
      ) VALUES (
        'agg_slot', 'agent_slot1', NULL, 'mcp-github',
        'direct', ${now}
      )
    `.execute(database.db);
    const result = (await sql<{ slot_app_id: string }>`
      SELECT slot_app_id FROM connection_aggregations WHERE id = 'agg_slot'
    `.execute(database.db)) as unknown as { rows: { slot_app_id: string }[] };
    expect(result.rows[0]?.slot_app_id).toBe("mcp-github");
  });

  it("aggregation slot uniqueness: same agent cannot have two slots of same app_id", async () => {
    await insertVirtualParent(database, "agent_dup");
    const now = new Date().toISOString();
    await sql`
      INSERT INTO connection_aggregations (
        id, parent_connection_id, child_connection_id, slot_app_id,
        dependency_mode, created_at
      ) VALUES (
        'agg_s1', 'agent_dup', NULL, 'mcp-github',
        'direct', ${now}
      )
    `.execute(database.db);
    await expect(
      sql`
        INSERT INTO connection_aggregations (
          id, parent_connection_id, child_connection_id, slot_app_id,
          dependency_mode, created_at
        ) VALUES (
          'agg_s2', 'agent_dup', NULL, 'mcp-github',
          'direct', ${now}
        )
      `.execute(database.db),
    ).rejects.toThrow();
  });
});
