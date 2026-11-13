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
import { createAutomationsStorage } from "./automations";
import { SqlThreadStorage } from "./threads";
import { ensureBuiltinAutomations } from "../automations/builtin";
import { sql } from "kysely";
import {
  TASK_BOARD_COMMENT_CREATE,
  TASK_BOARD_COMMENT_UPDATE,
} from "../tools/task-board/comments";
import { taskRunContextStore } from "../tools/task-board/task-run-context";
import { ensureReviewerCommented } from "../tools/task-board/reviewer-comment";
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
      storage: {
        taskBoard: storage,
        notifications,
        automations: createAutomationsStorage(database.db),
      },
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

  it("gives a reply the audience of the comment it answers", async () => {
    const handoff = await storage.createComment({
      taskBoardItemId: itemId,
      organizationId: "org_test",
      authorId: "super-agent",
      threadId: "thrd_run",
      audience: "internal",
      body: "handoff for the reviewer",
    });
    const reply = await storage.createComment({
      taskBoardItemId: itemId,
      organizationId: "org_test",
      authorId: "super-agent",
      threadId: "thrd_reviewer",
      parentId: handoff!.id,
      body: "noted",
    });
    expect(reply?.audience).toBe("internal");

    const explicit = await storage.createComment({
      taskBoardItemId: itemId,
      organizationId: "org_test",
      authorId: "user_1",
      parentId: handoff!.id,
      audience: "human",
      body: "a person chiming in",
    });
    expect(explicit?.audience).toBe("human");

    const question = await storage.createComment({
      taskBoardItemId: itemId,
      organizationId: "org_test",
      authorId: "user_1",
      body: "why this approach?",
    });
    expect(question?.audience).toBe("human");
  });

  it("keeps a run's handoff internal and silent, and notifies on its human note", async () => {
    const mention = `cc ${mentionMarkdown("user_123", "u123")}`;
    const unreadCount = async () =>
      (await notifications.listUnread("user_123", "org_test")).unreadCount;
    const before = await unreadCount();

    const inRun = <T>(fn: () => Promise<T>) =>
      taskRunContextStore.run({ threadId: "thrd_run_notify" }, fn);

    const handoff = await inRun(() =>
      TASK_BOARD_COMMENT_CREATE.handler(
        { taskBoardItemId: itemId, body: `${mention} handoff` },
        ctx,
      ),
    );
    expect(handoff.comment.audience).toBe("internal");
    expect(handoff.comment.authorId).toBe("super-agent");
    expect(await unreadCount()).toBe(before);

    const note = await inRun(() =>
      TASK_BOARD_COMMENT_CREATE.handler(
        {
          taskBoardItemId: itemId,
          body: `${mention} ready for review`,
          audience: "human",
        },
        ctx,
      ),
    );
    expect(note.comment.audience).toBe("human");
    expect(await unreadCount()).toBeGreaterThan(before);

    // Outside a run, a comment is a person's and stays visible.
    const own = await TASK_BOARD_COMMENT_CREATE.handler(
      { taskBoardItemId: itemId, body: "thanks" },
      ctx,
    );
    expect(own.comment.audience).toBe("human");
  });

  it("shows a change request's notes to the person when the reviewer told them nothing", async () => {
    const task = await storage.create({
      organizationId: "org_test",
      title: "Change request without a note",
      by: "user_test",
    });
    await storage.createComment({
      taskBoardItemId: task.id,
      organizationId: "org_test",
      authorId: "super-agent",
      threadId: "thrd_reviewer_cr",
      audience: "internal",
      body: "Reviewer pass: the discount rule in pricing.ts conflicts with the promo engine. NO VISUAL SURFACE, pricing logic only.",
    });

    const verdict = {
      decision: "request_changes" as const,
      notes: "Decide whether member discounts stack with promo codes.",
    };
    await ensureReviewerCommented(
      ctx,
      task,
      "reviewer",
      "thrd_reviewer_cr",
      verdict,
    );
    // A repeated decision call finds the note it just wrote.
    await ensureReviewerCommented(
      ctx,
      task,
      "reviewer",
      "thrd_reviewer_cr",
      verdict,
    );

    const comments = await storage.listComments(task.id, "org_test");
    const shown = comments.filter((c) => c.audience === "human");
    expect(shown).toHaveLength(1);
    expect(shown[0]!.threadId).toBe("thrd_reviewer_cr");
    expect(shown[0]!.body).toContain("Decide whether member discounts stack");
  });

  it("still shows a change request's notes when only the run's opening note is for people", async () => {
    const task = await storage.create({
      organizationId: "org_test",
      title: "Board review without a note",
      by: "user_test",
    });
    await storage.createRunRoot({
      taskBoardItemId: task.id,
      organizationId: "org_test",
      threadId: "thrd_reviewer_opened",
      body: "Reviewer started reviewing this card.",
    });
    const [opening] = await storage.listComments(task.id, "org_test");

    await ensureReviewerCommented(
      ctx,
      task,
      "reviewer",
      "thrd_reviewer_opened",
      {
        decision: "request_changes",
        notes: "Decide whether the banner shows on mobile. NO VISUAL SURFACE.",
      },
    );

    const mirrored = (await storage.listComments(task.id, "org_test")).filter(
      (c) => c.id !== opening!.id,
    );
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]).toMatchObject({
      parentId: opening!.id,
      audience: "human",
      threadId: "thrd_reviewer_opened",
    });
  });

  describe("board run threads", () => {
    let card: string;

    beforeAll(async () => {
      card = (
        await storage.create({
          organizationId: "org_test",
          title: "Card a board run works",
          by: "user_test",
        })
      ).id;
    });

    it("opens a run's thread once, and only on a card of the run's org", async () => {
      const opened = {
        taskBoardItemId: card,
        threadId: "thrd_board_once",
        body: "Implementer started working on this card.",
      };
      await storage.createRunRoot({ ...opened, organizationId: "org_other" });
      await storage.createRunRoot({ ...opened, organizationId: "org_test" });
      await storage.createRunRoot({ ...opened, organizationId: "org_test" });

      const roots = (await storage.listComments(card, "org_test")).filter(
        (c) => c.threadId === "thrd_board_once",
      );
      expect(roots).toHaveLength(1);
      expect(roots[0]).toMatchObject({
        parentId: null,
        authorId: "super-agent",
        audience: "human",
        body: opened.body,
      });
    });

    it("writes the run's notes under its opening note, as handoff unless addressed to people", async () => {
      await storage.createRunRoot({
        taskBoardItemId: card,
        organizationId: "org_test",
        threadId: "thrd_board_notes",
        body: "Implementer started working on this card.",
      });
      const opening = (await storage.listComments(card, "org_test")).find(
        (c) => c.threadId === "thrd_board_notes",
      );
      const inRun = <T>(fn: () => Promise<T>) =>
        taskRunContextStore.run({ threadId: "thrd_board_notes" }, fn);

      const handoff = await inRun(() =>
        TASK_BOARD_COMMENT_CREATE.handler(
          { taskBoardItemId: card, body: "Branch pushed, CI pending." },
          ctx,
        ),
      );
      const forPeople = await inRun(() =>
        TASK_BOARD_COMMENT_CREATE.handler(
          { taskBoardItemId: card, body: "PR is up.", audience: "human" },
          ctx,
        ),
      );

      expect(handoff.comment).toMatchObject({
        parentId: opening!.id,
        audience: "internal",
      });
      expect(forPeople.comment).toMatchObject({
        parentId: opening!.id,
        audience: "human",
      });
    });
  });

  describe("Super Agent mentions", () => {
    const MENTION = `${mentionMarkdown("super-agent", "Super Agent")} look`;
    let card: string;

    /** A run linked to `card`, in `status`. */
    const linkedRun = async (
      id: string,
      status: "completed" | "in_progress",
    ) => {
      await new SqlThreadStorage(database.db).create({
        id,
        organization_id: "org_test",
        title: "run",
        status,
        message_storage_version: 2,
        created_by: "user_test",
      });
      await storage.linkThread(card, id, "org_test");
    };

    beforeAll(async () => {
      await ensureBuiltinAutomations(database.db, {
        id: "org_test",
        createdBy: "user_test",
      });
      card = (
        await storage.create({
          organizationId: "org_test",
          title: "Card the agent works",
          by: "user_test",
        })
      ).id;
    });

    it("answers a run's own comment under the person's comment that started it", async () => {
      await linkedRun("thrd_mention_answer", "completed");
      const root = await storage.createComment({
        taskBoardItemId: card,
        organizationId: "org_test",
        authorId: "user_1",
        threadId: "thrd_mention_answer",
        body: MENTION,
      });

      const answer = await taskRunContextStore.run(
        { threadId: "thrd_mention_answer" },
        () =>
          TASK_BOARD_COMMENT_CREATE.handler(
            { taskBoardItemId: card, body: "Done, PR is up." },
            ctx,
          ),
      );

      expect(answer.comment.parentId).toBe(root!.id);
      expect(answer.comment.audience).toBe("human");
    });

    it("refuses a reply to a finished run while another works the card, and writes nothing", async () => {
      await linkedRun("thrd_mention_done", "completed");
      await linkedRun("thrd_mention_live", "in_progress");
      const root = await storage.createComment({
        taskBoardItemId: card,
        organizationId: "org_test",
        authorId: "user_1",
        threadId: "thrd_mention_done",
        body: MENTION,
      });
      const before = (await storage.listComments(card, "org_test")).length;

      await expect(
        TASK_BOARD_COMMENT_CREATE.handler(
          { taskBoardItemId: card, body: "one more thing", parentId: root!.id },
          ctx,
        ),
      ).rejects.toThrow(/Another run is working on this card/);
      expect(await storage.listComments(card, "org_test")).toHaveLength(before);
    });

    it("is a plain comment while Super Agent mentions is off", async () => {
      await sql`update automations set active = false
                 where organization_id = 'org_test' and system_key = 'agent_mentions'`.execute(
        database.db,
      );
      try {
        const posted = await TASK_BOARD_COMMENT_CREATE.handler(
          { taskBoardItemId: card, body: MENTION },
          ctx,
        );
        expect(posted.comment.threadId).toBeNull();
        expect(posted.comment.parentId).toBeNull();
      } finally {
        await sql`update automations set active = true
                   where organization_id = 'org_test' and system_key = 'agent_mentions'`.execute(
          database.db,
        );
      }
    });

    it("ties a comment to a run only within its own organization", async () => {
      const posted = await storage.createComment({
        taskBoardItemId: card,
        organizationId: "org_test",
        authorId: "user_1",
        body: "tie me",
      });

      await storage.setCommentThread(posted!.id, "org_other", "thrd_x");
      expect(
        (await storage.getComment(posted!.id, "org_test"))?.threadId,
      ).toBeNull();

      await storage.setCommentThread(posted!.id, "org_test", "thrd_x");
      expect((await storage.getComment(posted!.id, "org_test"))?.threadId).toBe(
        "thrd_x",
      );
    });
  });
});
