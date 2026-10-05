/**
 * Migration 231 gives the Jira agent to the orgs that already had an enabled
 * Jira integration, and only to them.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../src/database/test-db-pg";
import type { StudioDatabase } from "../src/database";
import { VirtualMCPStorage } from "../src/storage/virtual";
import { up as up231 } from "./231-jira-chat-agent";

setDefaultTimeout(30_000);

const USER = "user_test";

async function insertConnection(
  database: StudioDatabase,
  id: string,
  org: string,
  type: "VIRTUAL" | "HTTP",
): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO connections (
      id, organization_id, created_by, title, connection_type,
      connection_url, status, created_at, updated_at
    ) VALUES (
      ${id}, ${org}, ${USER}, ${id}, ${type},
      ${`http://${id}`}, 'active', ${now}, ${now}
    )
  `.execute(database.db);
}

async function insertIntegration(
  database: StudioDatabase,
  org: string,
  enabled: boolean,
): Promise<void> {
  await sql`
    INSERT INTO org_jira_integrations (
      organization_id, site_url, email, api_token, board_id, enabled, created_by
    ) VALUES (
      ${org}, 'https://example.atlassian.net', 'bot@example.test', 'enc',
      '42', ${enabled}, ${USER}
    )
  `.execute(database.db);
}

async function agentRows(database: StudioDatabase) {
  const { rows } = await sql<{
    id: string;
    organization_id: string;
    connection_type: string;
    status: string;
    child_connection_id: string | null;
    selected_tools: string | null;
  }>`
    SELECT c.id, c.organization_id, c.connection_type, c.status,
           a.child_connection_id, a.selected_tools::text AS selected_tools
    FROM connections c
    LEFT JOIN connection_aggregations a ON a.parent_connection_id = c.id
    WHERE c.id LIKE 'studio-jira\\_%'
    ORDER BY c.id
  `.execute(database.db);
  return rows;
}

describe("migration 231 — Jira chat agent", () => {
  let database: StudioDatabase;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
  });

  it("creates the agent only where the integration is enabled and self exists, once", async () => {
    // Enabled, with self: gets the agent.
    await insertConnection(database, "org_1_self", "org_1", "HTTP");
    await insertIntegration(database, "org_1", true);
    // Disabled: no agent.
    await insertConnection(database, "org_123_self", "org_123", "HTTP");
    await insertIntegration(database, "org_123", false);
    // Enabled but no self connection to aggregate: skipped.
    await insertIntegration(database, "org_456", true);
    // Already has the agent: left alone.
    await insertConnection(database, "org_test_self", "org_test", "HTTP");
    await insertIntegration(database, "org_test", true);
    await insertConnection(
      database,
      "studio-jira_org_test",
      "org_test",
      "VIRTUAL",
    );

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up231(database.db as any);
    // biome-ignore lint/suspicious/noExplicitAny: idempotence
    await up231(database.db as any);

    const rows = await agentRows(database);
    expect(rows.map((r) => r.id)).toEqual([
      "studio-jira_org_1",
      "studio-jira_org_test",
    ]);
    const created = rows[0];
    expect(created?.connection_type).toBe("VIRTUAL");
    expect(created?.status).toBe("active");
    expect(created?.child_connection_id).toBe("org_1_self");
    expect(JSON.parse(created?.selected_tools ?? "[]")).toContain(
      "JIRA_RUN_START",
    );
    // The pre-existing agent got no aggregation added by the migration.
    expect(rows[1]?.child_connection_id).toBeNull();

    // The row reads back as an ordinary agent.
    const agent = await new VirtualMCPStorage(database.db).findById(
      "studio-jira_org_1",
      "org_1",
    );
    expect(agent?.title).toBe("Jira");
    expect(agent?.connections[0]?.connection_id).toBe("org_1_self");
    expect(agent?.connections[0]?.selected_tools).toContain("JIRA_ISSUE_GET");
  });
});
