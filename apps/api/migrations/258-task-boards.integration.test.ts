/**
 * Migration 258 gives every organization, and every project with cards, a
 * development board and files each card under its project's board or its
 * organization's.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../src/database/test-db-pg";
import type { StudioDatabase } from "../src/database";
import { TaskBoardStorage } from "../src/storage/task-board";
import { up } from "./258-task-boards";

describe("migration 258 — task boards", () => {
  let database: StudioDatabase;
  let storage: TaskBoardStorage;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    storage = new TaskBoardStorage(database.db);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
  });

  // biome-ignore lint/suspicious/noExplicitAny: migrations accept the test Kysely instance
  const db = () => database.db as any;

  async function insertProject(id: string, organizationId: string) {
    await sql`
      insert into connections
        (id, organization_id, created_by, title, connection_type,
         connection_url, status, pinned, created_at, updated_at)
      values (${id}, ${organizationId}, 'user_test', ${id}, 'VIRTUAL',
              ${`virtual://${id}`}, 'active', false, now(), now())
    `.execute(database.db);
  }

  /** A card as a release without boards leaves it: no `board_id`. */
  async function legacyCard(
    organizationId: string,
    virtualMcpId?: string,
  ): Promise<string> {
    const item = await storage.create({
      organizationId,
      virtualMcpId,
      title: "card",
      by: "user_test",
    });
    await sql`update task_board_items set board_id = null where id = ${item.id}`.execute(
      database.db,
    );
    return item.id;
  }

  async function boardOf(itemId: string) {
    const { rows } = await sql<{
      organization_id: string;
      virtual_mcp_id: string | null;
      type: string;
    }>`
      select b.organization_id, b.virtual_mcp_id, b.type
        from task_board_items i join task_boards b on b.id = i.board_id
       where i.id = ${itemId}
    `.execute(database.db);
    return rows[0];
  }

  it("gives every organization and every project with cards a development board", async () => {
    await insertProject("vir_a", "org_1");
    await insertProject("vir_empty", "org_1");
    const orgCard = await legacyCard("org_1");
    const projectCard = await legacyCard("org_1", "vir_a");
    const otherOrgCard = await legacyCard("org_123");
    await sql`delete from task_boards`.execute(database.db);

    await up(db());

    const { rows } = await sql`
      select organization_id, virtual_mcp_id, type from task_boards
      order by organization_id, virtual_mcp_id nulls first
    `.execute(database.db);
    const development = (
      organization_id: string,
      virtual_mcp_id: string | null,
    ) => ({
      organization_id,
      virtual_mcp_id,
      type: "development",
    });
    expect(rows).toEqual([
      development("org_1", null),
      development("org_1", "vir_a"),
      development("org_123", null),
      development("org_456", null),
      development("org_test", null),
    ]);
    expect(await boardOf(orgCard)).toEqual(development("org_1", null));
    expect(await boardOf(projectCard)).toEqual(development("org_1", "vir_a"));
    expect(await boardOf(otherOrgCard)).toEqual(development("org_123", null));
  });

  it("keeps existing boards and is safe to run twice", async () => {
    const filed = await storage.create({
      organizationId: "org_1",
      title: "card",
      by: "user_test",
    });
    const unfiled = await legacyCard("org_1");

    await up(db());
    await up(db());

    const { rows } = await sql<{ id: string }>`
      select id from task_boards where organization_id = 'org_1'
    `.execute(database.db);
    expect(rows).toEqual([{ id: filed.boardId! }]);
    const { rows: cards } = await sql<{ board_id: string }>`
      select board_id from task_board_items where id = ${unfiled}
    `.execute(database.db);
    expect(cards[0]?.board_id).toBe(filed.boardId!);
  });
});
