/**
 * Real-Postgres coverage for seeding the built-in automations: every org gets
 * the implementer once, on In Progress, as its Super Agent, and an org that
 * turned it off keeps it off.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import { ensureBuiltinAutomations } from "./builtin";

describe("built-in automations (real Postgres)", () => {
  let database: StudioDatabase;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
  });

  beforeEach(async () => {
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  const member = (orgId: string, userId: string, createdAt: string) =>
    sql`
      insert into member (id, "organizationId", "userId", role, "createdAt")
      values (${`mem_${orgId}_${userId}`}, ${orgId}, ${userId}, 'owner', ${createdAt})
    `.execute(database.db);

  const implementers = async () =>
    (
      await sql<{
        organization_id: string;
        created_by: string;
        active: boolean;
        virtual_mcp_id: string;
        type: string;
        column_key: string;
        from_kind: string;
      }>`
        select a.organization_id, a.created_by, a.active, a.virtual_mcp_id,
               t.type, t.column_key, t.from_kind
          from automations a
          join automation_triggers t on t.automation_id = a.id
         where a.system_key = 'implementer'
         order by a.organization_id
      `.execute(database.db)
    ).rows;

  it("gives every org with a member one implementer, its earliest member standing in", async () => {
    await member("org_1", "user_123", "2026-01-02T00:00:00Z");
    await member("org_1", "user_1", "2026-01-01T00:00:00Z");
    await member("org_test", "user_test", "2026-01-01T00:00:00Z");

    await ensureBuiltinAutomations(database.db);
    await ensureBuiltinAutomations(database.db);

    expect(await implementers()).toEqual([
      {
        organization_id: "org_1",
        created_by: "user_1",
        active: true,
        virtual_mcp_id: "decopilot_org_1",
        type: "board_column_transition",
        column_key: "in_progress",
        from_kind: "any",
      },
      {
        organization_id: "org_test",
        created_by: "user_test",
        active: true,
        virtual_mcp_id: "decopilot_org_test",
        type: "board_column_transition",
        column_key: "in_progress",
        from_kind: "any",
      },
    ]);
  });

  it("seeds a new org with its creator before the member row exists", async () => {
    await ensureBuiltinAutomations(database.db, {
      id: "org_456",
      createdBy: "user_123",
    });

    expect(await implementers()).toEqual([
      expect.objectContaining({
        organization_id: "org_456",
        created_by: "user_123",
      }),
    ]);
  });

  it("leaves an implementer the org turned off alone", async () => {
    await member("org_1", "user_1", "2026-01-01T00:00:00Z");
    await ensureBuiltinAutomations(database.db);
    await sql`update automations set active = false where system_key = 'implementer'`.execute(
      database.db,
    );

    await ensureBuiltinAutomations(database.db);

    expect(await implementers()).toEqual([
      expect.objectContaining({ organization_id: "org_1", active: false }),
    ]);
  });
});
