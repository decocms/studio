import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql, type Kysely } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../src/database/test-db-pg";
import type { StudioDatabase } from "../src/database";
import { up } from "./262-deactivate-orphaned-agent-automations";

let database: StudioDatabase;
beforeAll(async () => {
  database = await connectTestPgDatabase();
  await seedCommonTestPgFixtures(database);
});
afterAll(async () => {
  await closeTestPgDatabase(database);
});

test("turns off only active automations whose agent row is gone", async () => {
  const transaction = await database.db.startTransaction().execute();
  try {
    const old = "2026-01-01T00:00:00.000Z";
    await sql`INSERT INTO connections (id, organization_id, created_by, title, connection_type, connection_url, status, created_at, updated_at)
      VALUES ('vir_live', 'org_1', 'user_1', 'Live agent', 'VIRTUAL', 'virtual://vir_live', 'active', ${old}, ${old})
    `.execute(transaction);
    await sql`INSERT INTO automations (id, organization_id, name, active, created_by, messages, models, virtual_mcp_id, created_at, updated_at)
      VALUES
      ('on_live', 'org_1', 'on live agent', true, 'user_1', '[]', '{}', 'vir_live', ${old}, ${old}),
      ('on_gone', 'org_1', 'on deleted agent', true, 'user_1', '[]', '{}', 'vir_gone', ${old}, ${old}),
      ('off_gone', 'org_1', 'already off', false, 'user_1', '[]', '{}', 'vir_gone', ${old}, ${old}),
      ('on_super', 'org_1', 'on the Super Agent', true, 'user_1', '[]', '{}', 'decopilot_org_1', ${old}, ${old})
    `.execute(transaction);

    await up(transaction as unknown as Kysely<unknown>);

    const { rows } = await sql<{
      id: string;
      active: boolean;
      touched: boolean;
    }>`
      SELECT id, active, updated_at <> ${old} AS touched
        FROM automations
       WHERE id IN ('on_live', 'on_gone', 'off_gone', 'on_super')
       ORDER BY id
    `.execute(transaction);
    expect(rows).toEqual([
      { id: "off_gone", active: false, touched: false },
      { id: "on_gone", active: false, touched: true },
      { id: "on_live", active: true, touched: false },
      { id: "on_super", active: true, touched: false },
    ]);
  } finally {
    await transaction.rollback().execute();
  }
});
