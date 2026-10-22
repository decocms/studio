/**
 * Migration 259 files the cards a release without boards created and makes
 * `board_id` required.
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
import { down, up } from "./259-task-board-items-board-required";

describe("migration 259 — cards require a board", () => {
  let database: StudioDatabase;
  let storage: TaskBoardStorage;

  // biome-ignore lint/suspicious/noExplicitAny: migrations accept the test Kysely instance
  const db = () => database.db as any;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    await down(db());
    storage = new TaskBoardStorage(database.db);
  });

  afterEach(async () => {
    await up(db());
    await closeTestPgDatabase(database);
  });

  async function insertProject(id: string, organizationId: string) {
    await sql`
      insert into connections
        (id, organization_id, created_by, title, connection_type,
         connection_url, status, pinned, created_at, updated_at)
      values (${id}, ${organizationId}, 'user_test', ${id}, 'VIRTUAL',
              ${`virtual://${id}`}, 'active', false, now(), now())
    `.execute(database.db);
  }

  /** A card as the release before boards leaves it: no `board_id`. */
  async function unfiledCard(
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

  it("files an unfiled card under its project's board or its organization's", async () => {
    await insertProject("vir_a", "org_1");
    const orgCard = await unfiledCard("org_1");
    const projectCard = await unfiledCard("org_1", "vir_a");

    await up(db());

    expect(await boardOf(orgCard)).toEqual({
      organization_id: "org_1",
      virtual_mcp_id: null,
      type: "development",
    });
    expect(await boardOf(projectCard)).toEqual({
      organization_id: "org_1",
      virtual_mcp_id: "vir_a",
      type: "development",
    });
  });

  it("creates the board an unfiled card needs when its scope has none", async () => {
    const unfiled = await unfiledCard("org_123");
    await sql`delete from task_boards where organization_id = 'org_123'`.execute(
      database.db,
    );

    await up(db());

    expect(await boardOf(unfiled)).toEqual({
      organization_id: "org_123",
      virtual_mcp_id: null,
      type: "development",
    });
  });

  it("rejects a card without a board afterwards", async () => {
    const item = await storage.create({
      organizationId: "org_1",
      title: "card",
      by: "user_test",
    });

    await up(db());

    await expect(
      sql`update task_board_items set board_id = null where id = ${item.id}`.execute(
        database.db,
      ),
    ).rejects.toThrow();
    await down(db());
  });
});
