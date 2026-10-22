/**
 * A card is filed under the board of its project (or of its organization when
 * it has none), created on first use; it follows its project, and a deleted
 * project hands its cards to the organization's board.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import type { StudioDatabase } from "../database";
import { TaskBoardStorage } from "./task-board";
import { VirtualMCPStorage } from "./virtual";

const ORG = "org_1";

describe("task boards", () => {
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

  async function insertProject(id: string, organizationId = ORG) {
    const now = new Date().toISOString();
    await database.db
      .insertInto("connections")
      .values({
        id,
        organization_id: organizationId,
        created_by: "user_test",
        updated_by: null,
        title: id,
        description: null,
        icon: null,
        app_name: null,
        app_id: null,
        slug: null,
        connection_type: "VIRTUAL",
        connection_url: `virtual://${id}`,
        connection_token: null,
        connection_headers: null,
        oauth_config: null,
        configuration_state: null,
        configuration_scopes: null,
        metadata: "{}",
        bindings: null,
        status: "active",
        pinned: false,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  const create = (organizationId: string, virtualMcpId?: string) =>
    storage.create({
      organizationId,
      virtualMcpId,
      title: "card",
      by: "user_test",
    });

  async function boards(organizationId: string) {
    const { rows } = await sql<{
      id: string;
      virtual_mcp_id: string | null;
      type: string;
    }>`
      select id, virtual_mcp_id, type from task_boards
      where organization_id = ${organizationId}
      order by virtual_mcp_id nulls first
    `.execute(database.db);
    return rows;
  }

  it("files a card without a project under its organization's development board", async () => {
    const first = await create(ORG);
    const second = await create(ORG);

    expect(await boards(ORG)).toEqual([
      { id: first.boardId!, virtual_mcp_id: null, type: "development" },
    ]);
    expect(second.boardId).toBe(first.boardId);
    expect((await storage.getById(first.id, ORG))?.boardId).toBe(first.boardId);
  });

  it("files a project's card under that project's board", async () => {
    await insertProject("vir_a");
    const orgCard = await create(ORG);
    const projectCard = await create(ORG, "vir_a");

    expect(projectCard.boardId).not.toBe(orgCard.boardId);
    expect(await boards(ORG)).toEqual([
      { id: orgCard.boardId!, virtual_mcp_id: null, type: "development" },
      {
        id: projectCard.boardId!,
        virtual_mcp_id: "vir_a",
        type: "development",
      },
    ]);
  });

  it("keeps organizations on their own boards", async () => {
    const a = await create("org_1");
    const b = await create("org_123");

    expect(a.boardId).not.toBe(b.boardId);
  });

  it("creates one board when a scope's first cards arrive together", async () => {
    const items = await Promise.all(
      Array.from({ length: 8 }, () => create("org_456")),
    );

    expect(await boards("org_456")).toHaveLength(1);
    expect(new Set(items.map((i) => i.boardId)).size).toBe(1);
  });

  it("moves a card to the board of the project it is moved to", async () => {
    await insertProject("vir_a");
    await insertProject("vir_b");
    const card = await create(ORG, "vir_a");
    const orgBoard = (await create(ORG)).boardId;

    const moved = await storage.update(
      card.id,
      ORG,
      { virtualMcpId: "vir_b" },
      "user_test",
    );
    const projectB = (await boards(ORG)).find(
      (b) => b.virtual_mcp_id === "vir_b",
    );
    expect(moved.boardId).toBe(projectB!.id);
    expect(moved.virtualMcpId).toBe("vir_b");

    const cleared = await storage.update(
      card.id,
      ORG,
      { virtualMcpId: null },
      "user_test",
    );
    expect(cleared.boardId).toBe(orgBoard);
  });

  it("refuses a board for another organization's project", async () => {
    await insertProject("vir_other", "org_123");

    await expect(create(ORG, "vir_other")).rejects.toThrow(
      /fk_task_boards_project/,
    );
  });

  it("refuses to file a card under another organization's board", async () => {
    const card = await create(ORG);
    const otherBoard = (await create("org_123")).boardId;

    await expect(
      sql`update task_board_items set board_id = ${otherBoard} where id = ${card.id}`.execute(
        database.db,
      ),
    ).rejects.toThrow(/fk_task_board_items_board/);
  });

  it("leaves the board alone on an update that does not touch the project", async () => {
    await insertProject("vir_a");
    const card = await create(ORG, "vir_a");

    const updated = await storage.update(
      card.id,
      ORG,
      { title: "renamed" },
      "user_test",
    );

    expect(updated.boardId).toBe(card.boardId);
  });

  it("hands a deleted project's cards to the organization's board", async () => {
    await insertProject("vir_a");
    const card = await create(ORG, "vir_a");
    await sql`update task_board_items set status = 'qa' where id = ${card.id}`.execute(
      database.db,
    );

    await new VirtualMCPStorage(database.db).delete("vir_a");

    const after = await storage.getById(card.id, ORG);
    const remaining = await boards(ORG);
    expect(remaining).toEqual([
      { id: after!.boardId!, virtual_mcp_id: null, type: "development" },
    ]);
    expect(after?.virtualMcpId).toBeNull();
    expect(after?.status).toBe("qa");
  });

  it("deletes the boards with their organization", async () => {
    await create("org_test");

    await sql`delete from organization where id = 'org_test'`.execute(
      database.db,
    );

    expect(await boards("org_test")).toEqual([]);
  });
});
