import { z } from "zod";
import type { Kysely } from "kysely";
import {
  CANONICAL_COLUMNS,
  SUPER_AGENT_ASSIGNEE_ID,
} from "@decocms/shared/task-board";
import { DemoRecipeSchema } from "@decocms/shared/demo";
import { ForbiddenError } from "@/core/access-control";
import { recipes } from "@/demo/scenario";
import {
  TaskBoardItemStatusSchema,
  TaskBoardItemPrioritySchema,
  TaskBoardItemTypeSchema,
} from "@/tools/task-board/schema";
import type { Database } from "./types";
import { TaskBoardStorage } from "./task-board";
import { DemoStorage } from "./demo";

const ChangeSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(50_000).nullable().optional(),
  status: TaskBoardItemStatusSchema.optional(),
  priority: TaskBoardItemPrioritySchema.optional(),
  type: TaskBoardItemTypeSchema.optional(),
  assigneeId: z.string().nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  sortOrder: z.number().finite().optional(),
  repo: z.string().nullable().optional(),
  linkThreadId: z.string().optional(),
  prUrl: z.string().nullable().optional(),
  tagIds: z.array(z.string()).optional(),
});
const TaskId = z.object({ taskBoardItemId: z.string() });

/** The regular tool wire contracts, backed by the same board storage inside the demo lock. */
export async function executeDemoTool(
  db: Kysely<Database>,
  orgId: string,
  actorId: string,
  name: string,
  input: unknown,
  origin: string,
  slug: string,
): Promise<{ result: unknown; runId?: string }> {
  const store = new DemoStorage(db);
  const board = new TaskBoardStorage(db);
  if (name === "TASK_BOARD_ITEM_LIST")
    return {
      result: {
        items: await board.list(orgId),
        repos: [],
        columns: CANONICAL_COLUMNS,
      },
    };
  if (name === "TASK_BOARD_ITEM_PRS_GET") {
    const { taskBoardItemId } = TaskId.parse(input);
    const task = await db
      .selectFrom("demo_tasks")
      .selectAll()
      .where("organization_id", "=", orgId)
      .where("task_id", "=", taskBoardItemId)
      .executeTakeFirst();
    const item = await board.getById(taskBoardItemId, orgId);
    if (!item) throw new ForbiddenError("Task not found");
    if (!task?.delivered) return { result: { prs: [] } };
    const recipe = recipes[DemoRecipeSchema.parse(task.recipe)];
    const root = `${origin}/api/${encodeURIComponent(slug)}/demo`;
    return {
      result: {
        prs: [
          {
            url: `${root}/changes/${item.id}`,
            number: item.keySeq ?? 1,
            repoOwner: "demo",
            repoName: "storefront",
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            title: recipe.title,
            body: recipe.result,
            state: item.status === "done" ? "closed" : "open",
            draft: false,
            merged: item.status === "done",
            mergeable: true,
            checksStatus: "passing",
            checks: [
              {
                name: "Prepared scenario checks",
                status: "completed",
                conclusion: "success",
                detailsUrl: null,
                summary: null,
              },
            ],
            previewUrl: `${root}/preview/${item.id}`,
          },
        ],
      },
    };
  }
  if (name === "TASK_BOARD_PREVIEW_PROBE") {
    const url = new URL(z.object({ url: z.string().url() }).parse(input).url);
    const prefix = `/api/${encodeURIComponent(slug)}/demo/preview/`;
    const id = url.pathname.startsWith(prefix)
      ? url.pathname.slice(prefix.length)
      : "";
    const exists =
      url.origin === new URL(origin).origin &&
      (await db
        .selectFrom("demo_tasks")
        .select("task_id")
        .where("organization_id", "=", orgId)
        .where("task_id", "=", id)
        .where("delivered", "=", true)
        .executeTakeFirst());
    return {
      result: { available: Boolean(exists), status: exists ? 200 : null },
    };
  }
  return store.mutate(orgId, actorId, async (trx, row) => {
    const board = new TaskBoardStorage(trx);
    if (
      name === "TASK_BOARD_ITEM_CREATE" ||
      name === "TASK_BOARD_ITEM_UPDATE"
    ) {
      const args = ChangeSchema.parse(input);
      if (args.repo || args.prUrl || args.linkThreadId || args.tagIds?.length)
        throw new ForbiddenError(
          "External repositories, PRs and chat links are unavailable in this scenario.",
        );
      if (args.assigneeId && args.assigneeId !== SUPER_AGENT_ASSIGNEE_ID) {
        const member = await trx
          .selectFrom("member")
          .select("id")
          .where("organizationId", "=", orgId)
          .where("userId", "=", args.assigneeId)
          .executeTakeFirst();
        if (!member)
          throw new ForbiddenError(
            "Assignee must be a member of this organization",
          );
      }
      const previous = args.id ? await board.getById(args.id, orgId) : null;
      if (name.endsWith("UPDATE") && !previous)
        throw new ForbiddenError(
          "Task no longer exists. The demonstration may have been restored.",
        );
      if (!previous && args.assigneeId === SUPER_AGENT_ASSIGNEE_ID)
        throw new ForbiddenError(
          "Create a prepared scenario task with the demonstration controls before delegating it.",
        );
      const delegate =
        args.assigneeId === SUPER_AGENT_ASSIGNEE_ID &&
        previous?.assigneeId !== SUPER_AGENT_ASSIGNEE_ID;
      if (
        delegate &&
        !(await trx
          .selectFrom("demo_tasks")
          .select("task_id")
          .where("organization_id", "=", orgId)
          .where("task_id", "=", previous!.id)
          .executeTakeFirst())
      )
        throw new ForbiddenError(
          "This task is outside the prepared demonstration. Use a scenario task.",
        );
      const item = previous
        ? await board.update(previous.id, orgId, args, actorId)
        : await board.create({
            ...args,
            title: args.title ?? "Untitled task",
            organizationId: orgId,
            by: actorId,
          });
      const run = delegate
        ? await store.start(trx, row, item.id, actorId)
        : null;
      return {
        result: { item: (await board.getById(item.id, orgId))! },
        ...(run ? { runId: run.id } : {}),
      };
    }
    if (name === "TASK_BOARD_ITEM_RERUN") {
      const { id } = z.object({ id: z.string() }).parse(input);
      const run = await store.start(trx, row, id, actorId);
      return {
        result: { status: "in_progress", supersededThreadIds: [] },
        runId: run.id,
      };
    }
    if (name === "TASK_BOARD_ITEM_DELETE") {
      const { id } = z.object({ id: z.string() }).parse(input);
      if (!(await board.delete(id, orgId, actorId)))
        throw new ForbiddenError("Task not found");
      return { result: { success: true } };
    }
    if (name === "TASK_BOARD_PROMOTE_TO_PRODUCTION") {
      const { taskBoardItemId } = TaskId.parse(input);
      const item = await board.getById(taskBoardItemId, orgId);
      const ready = await trx
        .selectFrom("demo_tasks")
        .select("delivered")
        .where("organization_id", "=", orgId)
        .where("task_id", "=", taskBoardItemId)
        .executeTakeFirst();
      if (
        !item ||
        !ready?.delivered ||
        !["in_review", "approved", "done"].includes(item.status)
      )
        throw new ForbiddenError(
          "Finish the prepared run and review its preview before approving.",
        );
      await board.update(item.id, orgId, { status: "done" }, actorId);
      await trx
        .updateTable("demo_tasks")
        .set({ published: true })
        .where("organization_id", "=", orgId)
        .where("task_id", "=", item.id)
        .execute();
      if (item.status !== "done")
        await board.recordActivity({
          taskBoardItemId: item.id,
          action: "status_changed",
          actorId,
          data: { from: item.status, to: "done", demo: true },
        });
      return { result: { status: "done", merged: true } };
    }
    if (name === "TASK_BOARD_COMMENT_CREATE") {
      const args = z
        .object({
          taskBoardItemId: z.string(),
          body: z.string().trim().min(1).max(50_000),
          parentId: z.string().nullish(),
        })
        .parse(input);
      const comment = await board.createComment({
        ...args,
        organizationId: orgId,
        authorId: actorId,
      });
      if (!comment)
        throw new ForbiddenError("Task or parent comment not found");
      return { result: { comment } };
    }
    if (name === "TASK_BOARD_COMMENT_UPDATE") {
      const args = z
        .object({
          id: z.string(),
          body: z.string().trim().min(1).max(50_000).optional(),
          resolved: z.boolean().optional(),
        })
        .parse(input);
      const comment = await board.updateComment({
        ...args,
        organizationId: orgId,
        callerId: actorId,
      });
      if (!comment)
        throw new ForbiddenError("Comment not found or not editable");
      return { result: { comment } };
    }
    if (name === "TASK_BOARD_COMMENT_DELETE") {
      const { id } = z.object({ id: z.string() }).parse(input);
      if (!(await board.deleteComment(id, orgId, actorId)))
        throw new ForbiddenError("Comment not found or not editable");
      return { result: { success: true } };
    }
    throw new ForbiddenError(
      "This action is outside the prepared demonstration.",
    );
  });
}
