import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql, type Kysely } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../src/database/test-db-pg";
import type { StudioDatabase } from "../src/database";
import { up as createRegistry } from "./062-private-registry";
import { up } from "./221-remove-private-registry";

let database: StudioDatabase;
beforeAll(async () => {
  database = await connectTestPgDatabase();
  await seedCommonTestPgFixtures(database);
});
afterAll(async () => {
  await closeTestPgDatabase(database);
});

test("removes the catalog and plugin storage while preserving installed MCPs and unrelated metadata", async () => {
  const transaction = await database.db.startTransaction().execute();
  try {
    const migrationDb = transaction as unknown as Kysely<unknown>;
    await createRegistry(migrationDb);
    await sql`ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS registry_config text, ADD COLUMN IF NOT EXISTS enabled_plugins text`.execute(
      transaction,
    );
    await transaction.schema
      .createTable("virtual_mcp_plugin_configs")
      .ifNotExists()
      .addColumn("id", "text")
      .execute();
    await sql`INSERT INTO connections (id, organization_id, title, connection_type, connection_url, app_name, metadata, created_by, status, pinned)
      VALUES
      ('org_1_registry', 'org_1', 'Deco registry', 'HTTP', 'https://example.com/registry', 'deco-registry', null, 'user_1', 'active', false),
      ('org_1_community-registry', 'org_1', 'Community registry', 'HTTP', 'https://example.com/community', 'mcp-registry', null, 'user_1', 'active', false),
      ('registry-migration-installed', 'org_1', 'Installed MCP', 'HTTP', 'https://example.com/mcp', 'deco/example', '{"enabled_plugins":["private-registry"],"keep":true}', 'user_1', 'active', false),
      ('registry-migration-malformed', 'org_1', 'Old metadata', 'HTTP', 'https://example.com/mcp', null, 'not-json', 'user_1', 'active', false),
      ('registry-migration-custom', 'org_1', 'User connection', 'HTTP', 'https://example.com/custom', 'deco-registry', null, 'user_1', 'active', false)
    `.execute(transaction);
    await sql`INSERT INTO connections (id, organization_id, title, connection_type, connection_url, app_name, app_id, created_by, status, pinned)
      VALUES ('registry-migration-monitor', 'org_1', 'Monitor', 'HTTP', 'https://example.com/mcp', 'private-registry-monitor', 'private-registry:monitor', 'user_1', 'active', false)`.execute(
      transaction,
    );
    await sql`INSERT INTO connection_aggregations (id, parent_connection_id, child_connection_id)
      VALUES ('registry-migration-link', 'registry-migration-installed', 'org_1_registry')`.execute(
      transaction,
    );
    await sql`INSERT INTO private_registry_item (id, organization_id, title, server_json)
      VALUES ('registry-migration-item', 'org_1', 'Old catalog item', '{"name":"example"}')`.execute(
      transaction,
    );

    await up(migrationDb);
    await up(migrationDb);

    const rows = await transaction
      .selectFrom("connections")
      .select(["id", "metadata", "connection_url"])
      .where("organization_id", "=", "org_1")
      .where("id", "in", [
        "org_1_registry",
        "org_1_community-registry",
        "registry-migration-installed",
        "registry-migration-malformed",
        "registry-migration-custom",
        "registry-migration-monitor",
      ])
      .execute();
    expect(rows.map((row) => row.id).sort()).toEqual([
      "registry-migration-custom",
      "registry-migration-installed",
      "registry-migration-malformed",
    ]);
    const installed = rows.find(
      (row) => row.id === "registry-migration-installed",
    );
    expect(installed?.connection_url).toBe("https://example.com/mcp");
    expect(JSON.parse(String(installed?.metadata))).toEqual({ keep: true });
    expect(
      String(
        rows.find((row) => row.id === "registry-migration-malformed")?.metadata,
      ),
    ).toBe("not-json");
    const tables = await sql<{
      name: string;
    }>`SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema() AND (tablename LIKE 'private_registry_%' OR tablename = 'virtual_mcp_plugin_configs')`.execute(
      transaction,
    );
    expect(tables.rows).toEqual([]);
    const columns = await sql<{
      name: string;
    }>`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'organization_settings' AND column_name IN ('registry_config', 'enabled_plugins')`.execute(
      transaction,
    );
    expect(columns.rows).toEqual([]);
  } finally {
    await transaction.rollback().execute();
  }
});
