/**
 * Integration test for migration 097: connection access + agent slots.
 *
 * Covers:
 *   1. Existing connections rows are backfilled to access='org'.
 *   2. New inserts that omit access get the post-migration default 'user'.
 *   3. CHECK constraint rejects access values other than 'user' / 'org'.
 *   4. connection_aggregations supports concrete child OR slot, not both/neither.
 *   5. Partial unique index R4: one user-private connection per (org, user, app_id).
 *   6. Partial unique index for slots: one slot per (agent, app_id).
 *   7. Down migration cleanly reverses all changes.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Migrator, sql } from "kysely";
import migrations from "./index";
import {
  closeTestDatabase,
  createTestDatabase,
  type TestDatabase,
} from "../src/database/test-db";
import {
  createBetterAuthTables,
  createTestSchema,
  seedCommonTestFixtures,
} from "../src/storage/test-helpers";
import {
  up as up097,
  down as down097,
} from "./097-connection-access-and-slots";

const USER_A = "user_test";
const USER_B = "user_1"; // both seeded by seedCommonTestFixtures
const ORG = "org_test";

interface ConnectionRow {
  id: string;
  access: string;
  app_id: string | null;
  created_by: string;
}

async function insertConnection(
  database: TestDatabase,
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
  database: TestDatabase,
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

async function getAccess(database: TestDatabase, id: string): Promise<string> {
  const result = (await sql<ConnectionRow>`
    SELECT id, access, app_id, created_by FROM connections WHERE id = ${id}
  `.execute(database.db)) as unknown as { rows: ConnectionRow[] };
  const row = result.rows[0];
  if (!row) throw new Error(`connection ${id} not found`);
  return row.access;
}

describe("migration 097 — connection access + slots", () => {
  describe("backfill of existing rows", () => {
    let database: TestDatabase;

    beforeEach(async () => {
      database = await createTestDatabase();
      // Better Auth tables (organization, user) must exist for FK constraints
      // referenced by migration 001's connections table.
      await createBetterAuthTables(database.db);
      // Roll only up to 096 so the access column does not yet exist.
      const migrator = new Migrator({
        db: database.db,
        provider: { getMigrations: () => Promise.resolve(migrations) },
      });
      const { error } = await migrator.migrateTo(
        "096-org-file-configs-public-url-base",
      );
      if (error) throw error;
      await seedCommonTestFixtures(database.db);
    });

    afterEach(async () => {
      await closeTestDatabase(database);
    });

    it("backfills existing connections rows to access='org'", async () => {
      // Insert pre-097 row (no access column yet).
      const now = new Date().toISOString();
      await sql`
        INSERT INTO connections (
          id, organization_id, created_by, title, connection_type,
          connection_url, status, created_at, updated_at
        ) VALUES (
          'conn_legacy', ${ORG}, ${USER_A}, 'legacy', 'HTTP',
          'https://example.com', 'active', ${now}, ${now}
        )
      `.execute(database.db);

      // biome-ignore lint/suspicious/noExplicitAny: migration accepts test Kysely instance
      await up097(database.db as any);

      const access = await getAccess(database, "conn_legacy");
      expect(access).toBe("org");
    });
  });

  describe("post-migration schema behavior", () => {
    let database: TestDatabase;

    beforeEach(async () => {
      database = await createTestDatabase();
      await createTestSchema(database.db); // includes 097 once registered
      await seedCommonTestFixtures(database.db);
    });

    afterEach(async () => {
      await closeTestDatabase(database);
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

  describe("down rollback", () => {
    let database: TestDatabase;

    beforeEach(async () => {
      database = await createTestDatabase();
      await createTestSchema(database.db);
      await seedCommonTestFixtures(database.db);
    });

    afterEach(async () => {
      await closeTestDatabase(database);
    });

    it("removes access column, slot_app_id column, indexes, and CHECKs", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: migration accepts test Kysely instance
      await down097(database.db as any);

      const accessColCount = (await sql<{ count: string }>`
        SELECT COUNT(*)::text as count
        FROM information_schema.columns
        WHERE table_name = 'connections' AND column_name = 'access'
      `.execute(database.db)) as unknown as { rows: { count: string }[] };
      expect(Number(accessColCount.rows[0]?.count)).toBe(0);

      const slotColCount = (await sql<{ count: string }>`
        SELECT COUNT(*)::text as count
        FROM information_schema.columns
        WHERE table_name = 'connection_aggregations' AND column_name = 'slot_app_id'
      `.execute(database.db)) as unknown as { rows: { count: string }[] };
      expect(Number(slotColCount.rows[0]?.count)).toBe(0);
    });
  });
});
