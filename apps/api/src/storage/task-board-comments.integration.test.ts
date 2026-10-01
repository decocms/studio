import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import type { StudioContext } from "../core/studio-context";
import type { StudioDatabase } from "../database";
import { TaskBoardStorage } from "./task-board";
import { NotificationStorage } from "./notifications";
import { TASK_BOARD_COMMENT_UPDATE } from "../tools/task-board/comments";
import { mentionMarkdown } from "@decocms/shared/mentions";

describe("TaskBoardStorage comments", () => {
  let database: StudioDatabase;
  let storage: TaskBoardStorage;
  let notifications: NotificationStorage;
  let itemId: string;
  let ctx: StudioContext;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    storage = new TaskBoardStorage(database.db);
    notifications = new NotificationStorage(database.db);
    ctx = {
      timings: {
        measure: async <T>(_name: string, cb: () => Promise<T>) => await cb(),
      },
      auth: { user: { id: "user_1", email: "user_1@test.com", name: "u1" } },
      organization: { id: "org_test", slug: "org_test", name: "org_test" },
      storage: { taskBoard: storage, notifications },
      access: {
        granted: () => true,
        check: async () => {},
        grant: () => {},
        setToolName: () => {},
      },
    } as unknown as StudioContext;

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

  it("round-trips the writing run's thread id", async () => {
    // What tells one agent's comments from another's — they all share the
    // synthetic author id, so the `update()` whitelist dropping this column
    // would silently break the reviewer-comment check.
    const agent = await storage.createComment({
      taskBoardItemId: itemId,
      organizationId: "org_test",
      authorId: "super-agent",
      threadId: "thrd_qa_run",
      body: "QA pass recorded",
    });
    expect(agent?.threadId).toBe("thrd_qa_run");

    const human = await storage.createComment({
      taskBoardItemId: itemId,
      organizationId: "org_test",
      authorId: "user_1",
      body: "looks fine",
    });
    expect(human?.threadId).toBeNull();

    const listed = await storage.listComments(itemId, "org_test");
    expect(listed.find((c) => c.id === agent!.id)?.threadId).toBe(
      "thrd_qa_run",
    );
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
    expect(stolenDelete).toBeNull();

    const ownDelete = await storage.deleteComment(
      comment!.id,
      "org_test",
      "user_1",
    );
    expect(ownDelete).not.toBeNull();
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
    expect(deleted).not.toBeNull();
  });

  it("deleting a thread root hands back the root and every reply it took with it", async () => {
    const root = await storage.createComment({
      taskBoardItemId: itemId,
      organizationId: "org_test",
      authorId: "user_1",
      body: "root with a screenshot",
    });
    const reply = await storage.createComment({
      taskBoardItemId: itemId,
      organizationId: "org_test",
      authorId: "user_123",
      parentId: root!.id,
      body: "reply with a pdf",
    });

    const removed = await storage.deleteComment(root!.id, "org_test", "user_1");

    expect(removed?.map((c) => c.body).sort()).toEqual([
      "reply with a pdf",
      "root with a screenshot",
    ]);
    const left = await storage.listComments(itemId, "org_test");
    expect(left.some((c) => c.id === root!.id || c.id === reply!.id)).toBe(
      false,
    );
  });

  it("tells a deleted task from a dismissed one, whose comments stay", async () => {
    const mine = await storage.create({
      organizationId: "org_test",
      title: "user task",
      by: "user_1",
    });
    const finding = await storage.create({
      organizationId: "org_test",
      title: "reports task",
      externalKey: "diag:example.com:lcp",
      by: "system",
    });
    await storage.createComment({
      taskBoardItemId: finding.id,
      organizationId: "org_test",
      authorId: "user_1",
      body: "kept with the card",
    });

    expect(await storage.delete(mine.id, "org_test", "user_1")).toBe("deleted");
    expect(await storage.delete(finding.id, "org_test", "user_1")).toBe(
      "dismissed",
    );
    expect(await storage.delete("board_missing", "org_test", "user_1")).toBe(
      null,
    );
    const kept = await storage.listComments(finding.id, "org_test");
    expect(kept.map((c) => c.body)).toEqual(["kept with the card"]);
  });

  it("notifies a member newly @-mentioned by editing a comment's body", async () => {
    await database.db
      .insertInto("member")
      .values({
        id: "member_comment_mention",
        organizationId: "org_test",
        userId: "user_123",
        role: "member",
        createdAt: new Date().toISOString(),
      })
      .execute();
    const comment = await storage.createComment({
      taskBoardItemId: itemId,
      organizationId: "org_test",
      authorId: "user_1",
      body: "no mentions yet",
    });
    expect(comment).not.toBeNull();

    // Before fix: TASK_BOARD_COMMENT_UPDATE never ran notifyMentions.
    await TASK_BOARD_COMMENT_UPDATE.handler(
      {
        id: comment!.id,
        body: `cc ${mentionMarkdown("user_123", "u123")} please take a look`,
      },
      ctx,
    );

    const unread = await notifications.listUnread("user_123", "org_test");
    expect(unread.unreadCount).toBe(1);
    expect(unread.notifications[0]!.type).toBe("mentioned");
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
