import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { TaskBoardStorage } from "./task-board";

/**
 * Real-Postgres coverage for persisted task project ownership.
 *
 * `TaskBoardStorage.update` has an explicit column whitelist, so type-only or
 * in-memory coverage would miss the exact regression where a valid
 * `virtualMcpId` is accepted and then silently discarded.
 */
const ORG = "org_task_project_owner";
const USER = "user_task_project_owner";

describe("TaskBoardStorage — virtualMcpId", () => {
  let database: StudioDatabase;
  let storage: TaskBoardStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const createdAt = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${`${USER}@test.com`}, false, 'Task Project Owner', ${createdAt}, ${createdAt})
    `.execute(database.db);
    await database.db
      .insertInto("organization")
      .values({ id: ORG, name: ORG, slug: "task-project-owner", createdAt })
      .execute();
    storage = new TaskBoardStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("persists ownership through create, list, get, update, and clear", async () => {
    const created = await storage.create({
      organizationId: ORG,
      title: "Owned by project A",
      virtualMcpId: "vir_project_a",
      repo: "acme/site",
      by: USER,
    });
    expect(created.virtualMcpId).toBe("vir_project_a");
    expect((await storage.getById(created.id, ORG))?.virtualMcpId).toBe(
      "vir_project_a",
    );
    expect(
      (await storage.list(ORG)).find((item) => item.id === created.id)
        ?.virtualMcpId,
    ).toBe("vir_project_a");

    const moved = await storage.update(
      created.id,
      ORG,
      { virtualMcpId: "vir_project_b" },
      USER,
    );
    expect(moved.virtualMcpId).toBe("vir_project_b");
    expect((await storage.getById(created.id, ORG))?.virtualMcpId).toBe(
      "vir_project_b",
    );

    const cleared = await storage.update(
      created.id,
      ORG,
      { virtualMcpId: null },
      USER,
    );
    expect(cleared.virtualMcpId).toBeNull();
  });

  it("keeps organization and pre-migration-style cards explicitly null", async () => {
    const legacy = await storage.create({
      organizationId: ORG,
      title: "Organization task",
      by: USER,
    });

    expect(legacy.virtualMcpId).toBeNull();
    const row = await database.db
      .selectFrom("task_board_items")
      .select("virtual_mcp_id")
      .where("id", "=", legacy.id)
      .executeTakeFirstOrThrow();
    expect(row.virtual_mcp_id).toBeNull();
  });
});
