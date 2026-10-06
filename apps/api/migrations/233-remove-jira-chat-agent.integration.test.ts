import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql, type Kysely } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../src/database/test-db-pg";
import type { StudioDatabase } from "../src/database";
import { up } from "./233-remove-jira-chat-agent";

let database: StudioDatabase;
beforeAll(async () => {
  database = await connectTestPgDatabase();
  await seedCommonTestPgFixtures(database);
});
afterAll(async () => {
  await closeTestPgDatabase(database);
});

test("deletes the Jira agents with their threads and aggregations, and nothing else", async () => {
  const transaction = await database.db.startTransaction().execute();
  try {
    await sql`INSERT INTO connections (id, organization_id, title, connection_type, connection_url, created_by, status, pinned)
      VALUES
      ('studio-jira_org_1', 'org_1', 'Jira', 'VIRTUAL', 'virtual://studio-jira_org_1', 'user_1', 'active', false),
      ('jira-migration-agent', 'org_1', 'Jira', 'VIRTUAL', 'virtual://jira-migration-agent', 'user_1', 'active', false),
      ('jira-migration-child', 'org_1', 'Child', 'HTTP', 'https://example.com/mcp', 'user_1', 'active', false)
    `.execute(transaction);
    await sql`INSERT INTO connection_aggregations (id, parent_connection_id, child_connection_id)
      VALUES
      ('jira-migration-agg', 'studio-jira_org_1', 'jira-migration-child'),
      ('jira-migration-agg-kept', 'jira-migration-agent', 'jira-migration-child')
    `.execute(transaction);
    await sql`INSERT INTO threads (id, organization_id, title, created_by, virtual_mcp_id)
      VALUES
      ('jira-migration-thread', 'org_1', 'Chat', 'user_1', 'studio-jira_org_1'),
      ('jira-migration-thread-kept', 'org_1', 'Chat', 'user_1', 'jira-migration-agent')
    `.execute(transaction);

    const migrationDb = transaction as unknown as Kysely<unknown>;
    await up(migrationDb);
    await up(migrationDb);

    const connections = await transaction
      .selectFrom("connections")
      .select("id")
      .where("id", "in", [
        "studio-jira_org_1",
        "jira-migration-agent",
        "jira-migration-child",
      ])
      .execute();
    expect(connections.map((row) => row.id).sort()).toEqual([
      "jira-migration-agent",
      "jira-migration-child",
    ]);

    const aggregations = await transaction
      .selectFrom("connection_aggregations")
      .select("id")
      .where("id", "in", ["jira-migration-agg", "jira-migration-agg-kept"])
      .execute();
    expect(aggregations.map((row) => row.id)).toEqual([
      "jira-migration-agg-kept",
    ]);

    const threads = await transaction
      .selectFrom("threads")
      .select("id")
      .where("id", "in", [
        "jira-migration-thread",
        "jira-migration-thread-kept",
      ])
      .execute();
    expect(threads.map((row) => row.id)).toEqual([
      "jira-migration-thread-kept",
    ]);
  } finally {
    await transaction.rollback().execute();
  }
});
