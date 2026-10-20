import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  connectTestPgDatabase,
  closeTestPgDatabase,
} from "../database/test-db-pg";
import { TaskBoardStorage } from "./task-board";

describe("task board harness persistence", () => {
  let database: StudioDatabase;
  let storage: TaskBoardStorage;
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const otherOrgId = `org_${randomUUID()}`;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    storage = new TaskBoardStorage(database.db);
    const now = new Date().toISOString();
    await sql`INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${userId}, ${`${userId}@example.test`}, false, 'Harness test', ${now}, ${now})`.execute(
      database.db,
    );
    for (const id of [orgId, otherOrgId]) {
      await database.db
        .insertInto("organization")
        .values({ id, name: "Harness test", slug: id, createdAt: now })
        .execute();
    }
  });
  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  test("omitted selection keeps the legacy runtime", async () => {
    const item = await storage.create({
      organizationId: orgId,
      title: "Default runtime",
      by: userId,
    });
    expect(item.harnessId).toBe("claude-code");
    expect((await storage.getById(item.id, orgId))?.harnessId).toBe(
      "claude-code",
    );
  });

  test("selection survives reads and unrelated updates", async () => {
    const item = await storage.create({
      organizationId: orgId,
      title: "Codex task",
      harnessId: "codex",
      by: userId,
    });
    expect(item.harnessId).toBe("codex");
    await storage.update(item.id, orgId, { title: "Updated task" }, userId);
    expect((await storage.getById(item.id, orgId))?.harnessId).toBe("codex");
    await storage.update(item.id, orgId, { harnessId: "claude-code" }, userId);
    expect((await storage.getById(item.id, orgId))?.harnessId).toBe(
      "claude-code",
    );
    await storage.update(item.id, orgId, { harnessId: "codex" }, userId);
    await expect(
      storage.update(item.id, otherOrgId, { harnessId: "claude-code" }, userId),
    ).rejects.toThrow();
    expect(await storage.getById(item.id, otherOrgId)).toBeNull();
    expect((await storage.getById(item.id, orgId))?.harnessId).toBe("codex");
    await storage.delete(item.id, orgId, userId);
    expect(await storage.getById(item.id, orgId)).toBeNull();
  });

  test("the database rejects unsupported runtimes", async () => {
    const item = await storage.create({
      organizationId: orgId,
      title: "Invalid runtime",
      by: userId,
    });
    await expect(
      sql`UPDATE task_board_items SET harness_id = 'unknown' WHERE id = ${item.id} AND organization_id = ${orgId}`.execute(
        database.db,
      ),
    ).rejects.toThrow();
  });
});
