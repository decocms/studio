import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import type { StudioDatabase } from "../database";
import { TaskBoardStorage } from "./task-board";

describe("TaskBoardStorage comments", () => {
  let database: StudioDatabase;
  let storage: TaskBoardStorage;
  let itemId: string;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    storage = new TaskBoardStorage(database.db);

    const item = await storage.create({
      organizationId: "org_test",
      title: "Task with comments",
      by: "user_test",
    });
    itemId = item.id;
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("lets only the author edit a comment's body", async () => {
    const comment = await storage.createComment({
      taskBoardItemId: itemId,
      organizationId: "org_test",
      authorId: "user_1",
      body: "original",
    });
    expect(comment).not.toBeNull();

    // Before fix: any org member could edit anyone's comment body.
    const stolen = await storage.updateComment({
      id: comment!.id,
      organizationId: "org_test",
      callerId: "user_123",
      body: "hijacked",
    });
    expect(stolen).toBeNull();

    const own = await storage.updateComment({
      id: comment!.id,
      organizationId: "org_test",
      callerId: "user_1",
      body: "edited by author",
    });
    expect(own?.body).toBe("edited by author");
  });

  it("lets anyone resolve a thread, but only the author delete it", async () => {
    const comment = await storage.createComment({
      taskBoardItemId: itemId,
      organizationId: "org_test",
      authorId: "user_1",
      body: "resolvable",
    });
    expect(comment).not.toBeNull();

    const resolved = await storage.updateComment({
      id: comment!.id,
      organizationId: "org_test",
      callerId: "user_123",
      resolved: true,
    });
    expect(resolved?.resolved).toBe(true);

    // Before fix: any org member could delete anyone's comment.
    const stolenDelete = await storage.deleteComment(
      comment!.id,
      "org_test",
      "user_123",
    );
    expect(stolenDelete).toBe(false);

    const ownDelete = await storage.deleteComment(
      comment!.id,
      "org_test",
      "user_1",
    );
    expect(ownDelete).toBe(true);
  });

  it("lets any org member delete a Super Agent comment", async () => {
    const comment = await storage.createComment({
      taskBoardItemId: itemId,
      organizationId: "org_test",
      authorId: "super-agent",
      body: "posted during a run",
    });
    expect(comment).not.toBeNull();

    // Before fix: no caller's id ever equals "super-agent", so this comment
    // could never be deleted by anyone.
    const deleted = await storage.deleteComment(
      comment!.id,
      "org_test",
      "user_123",
    );
    expect(deleted).toBe(true);
  });

  it("rejects resolving a reply — resolved is a thread-root-only property", async () => {
    const root = await storage.createComment({
      taskBoardItemId: itemId,
      organizationId: "org_test",
      authorId: "user_1",
      body: "root",
    });
    const reply = await storage.createComment({
      taskBoardItemId: itemId,
      organizationId: "org_test",
      authorId: "user_1",
      parentId: root!.id,
      body: "reply",
    });
    expect(reply).not.toBeNull();

    // Before fix: any reply could be marked resolved, a no-op the UI can't
    // reflect since resolved only renders on the root.
    const result = await storage.updateComment({
      id: reply!.id,
      organizationId: "org_test",
      callerId: "user_123",
      resolved: true,
    });
    expect(result).toBeNull();
  });
});
