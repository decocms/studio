/**
 * Comments on a task — threads in the task dialog's activity feed, one level of
 * replies deep. Create/update/delete ship together; the list tool is flat and
 * the UI nests by `parentId`.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { getUserId, requireAuth } from "@/core/studio-context";
import type { StudioContext } from "@/core/studio-context";
import { orgRelativePath } from "@decocms/shared/organization/home-mount";
import {
  SUPER_AGENT_ASSIGNEE_ID,
  TASK_COMMENT_AUDIENCES,
} from "@decocms/shared/task-board";
import {
  commentUploadsAsSandboxPaths,
  sandboxPathsAsUploads,
} from "./description-uploads";
import { taskRunContextStore } from "./task-run-context";

/** No real comment is this long — caps the row a single POST can write. */
const MAX_COMMENT_BODY_LENGTH = 50_000;

const TaskBoardCommentSchema = z.object({
  id: z.string(),
  taskBoardItemId: z.string(),
  /** Null on a thread root; a reply points at its root. */
  parentId: z.string().nullable(),
  authorId: z.string(),
  /** Source run, when this comment was written by an agent. */
  threadId: z.string().nullable().optional(),
  audience: z.enum(TASK_COMMENT_AUDIENCES),
  body: z.string(),
  /** Thread roots only — a thread is settled or open as a whole. */
  resolved: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function requireOrg(ctx: StudioContext): string {
  const organizationId = ctx.organization?.id;
  if (!organizationId) {
    throw new Error(
      "Organization ID required (no active organization in context)",
    );
  }
  return organizationId;
}

export const TASK_BOARD_COMMENT_LIST = defineTool({
  name: "TASK_BOARD_COMMENT_LIST",
  description:
    "List a task board item's comments (flat, oldest first; replies carry parentId). " +
    "Inside a task run, files attached to a comment appear as sandbox paths (`org/.uploads/…`) you can Read.",
  annotations: {
    title: "List Task Comments",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ taskBoardItemId: z.string() }),
  outputSchema: z.object({ comments: z.array(TaskBoardCommentSchema) }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const comments = await ctx.storage.taskBoard.listComments(
      input.taskBoardItemId,
      requireOrg(ctx),
    );
    // A run's endpoint is sandbox-hosted (thread-mcp.ts): there an upload's `/api/…` URL can't be fetched, its mounted path can.
    const orgSlug = ctx.organization?.slug;
    if (!taskRunContextStore.getStore() || !orgSlug) return { comments };
    return {
      comments: comments.map((comment) => ({
        ...comment,
        body: commentUploadsAsSandboxPaths(comment.body, orgSlug),
      })),
    };
  },
});

/**
 * A task-run agent (the QA reviewer) writes screenshots to `/app/org/output/…`
 * and references them in its comment as markdown images
 * `![alt](/app/org/output/x.png)` (older runs wrote the relative
 * `org/output/…`). That dir materializes into the org-fs `outputs` volume
 * under the run's thread id, served at
 * `/api/<org>/fs/outputs/read?path=<threadId>/<subpath>` — the same URL the
 * thread Outputs panel builds. Rewrite those refs to that URL here (the agent
 * can't know its own thread id) so the image renders inline in the comment.
 * Only output image refs are touched; every other URL is left as-is.
 * `outputs` is a member-readable volume, so the browser's session loads the
 * same-origin `<img>`.
 */
const MARKDOWN_IMG_RE = /(!\[[^\]]*\]\()([^)\s]+)(\))/g;
const OUTPUT_PREFIX = "output/";
export function embedOrgOutputImages(
  body: string,
  threadId: string,
  orgSlug: string,
): string {
  return body.replace(MARKDOWN_IMG_RE, (match, pre, target, post) => {
    const rel = orgRelativePath(target);
    if (!rel?.startsWith(OUTPUT_PREFIX)) return match;
    const subpath = rel.slice(OUTPUT_PREFIX.length);
    const path = encodeURIComponent(`${threadId}/${subpath}`);
    return `${pre}/api/${encodeURIComponent(orgSlug)}/fs/outputs/read?path=${path}${post}`;
  });
}

/**
 * A body a run wrote, made renderable: its `org/output/…` screenshots, any
 * mounted path it read through `TASK_BOARD_COMMENT_LIST` and wrote back, and
 * screenshots it saved through the hidden mounts.
 */
function bodyFromRun(body: string, threadId: string, orgSlug: string): string {
  return sandboxPathsAsUploads(
    embedOrgOutputImages(body, threadId, orgSlug),
    orgSlug,
  );
}

export const TASK_BOARD_COMMENT_CREATE = defineTool({
  name: "TASK_BOARD_COMMENT_CREATE",
  description:
    "Post a comment on a task board item, or a reply to one. " +
    'Inside a task run a new comment is `internal` by default: handoff for other agents, hidden from the people reading the task. Pass `audience: "human"` for the note written for them. A reply takes the audience of the comment it answers unless you pass one.',
  annotations: {
    title: "Create Task Comment",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    taskBoardItemId: z.string(),
    body: z.string().trim().min(1).max(MAX_COMMENT_BODY_LENGTH),
    /** Reply target. Replying to a reply lands on its thread root. */
    parentId: z.string().nullish(),
    audience: z.enum(TASK_COMMENT_AUDIENCES).optional(),
  }),
  outputSchema: z.object({ comment: TaskBoardCommentSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = requireOrg(ctx);
    // A comment from a task run is the Super Agent's, not the user's whose
    // credential the run acts under (the assigner) — see authorId below. The
    // store also carries the run's thread id, which is what turns the agent's
    // `/app/org/output/…` screenshot refs into renderable image URLs.
    const taskRun = taskRunContextStore.getStore();
    const orgSlug = ctx.organization?.slug;
    const body =
      taskRun?.threadId && orgSlug
        ? bodyFromRun(input.body, taskRun.threadId, orgSlug)
        : input.body;
    const comment = await ctx.storage.taskBoard.createComment({
      taskBoardItemId: input.taskBoardItemId,
      organizationId,
      parentId: input.parentId ?? null,
      // Same id the board already uses for the agent as an assignee, so the UI
      // renders it as the agent without a second concept.
      authorId: taskRun ? SUPER_AGENT_ASSIGNEE_ID : getUserId(ctx)!,
      // Which run wrote it — the only way to tell one agent's comments from
      // another's, since they all share the author id above.
      threadId: taskRun?.threadId ?? null,
      // A run's new thread is handoff; its reply goes to whoever it answers.
      audience:
        input.audience ?? (taskRun && !input.parentId ? "internal" : undefined),
      body,
    });
    if (!comment) throw new Error("Task board item not found");
    // Nobody is notified about a comment the feed hides from them.
    if (comment.audience === "internal") return { comment };
    // Not an activity action, hence its own fan-out. The agent has no inbox.
    await ctx.storage.notifications.notify({
      taskBoardItemId: comment.taskBoardItemId,
      type: "commented",
      actorId: taskRun ? null : getUserId(ctx)!,
      alsoSubscribe: taskRun ? [] : [getUserId(ctx)!],
    });
    // Separate from the "commented" fan-out above: that one reaches the task's
    // followers, this one the people the comment names — who may be neither.
    await ctx.storage.notifications.notifyMentions({
      taskBoardItemId: comment.taskBoardItemId,
      organizationId,
      actorId: taskRun ? null : getUserId(ctx)!,
      body: comment.body,
    });
    return { comment };
  },
});

export const TASK_BOARD_COMMENT_UPDATE = defineTool({
  name: "TASK_BOARD_COMMENT_UPDATE",
  description:
    "Edit your own comment's body, or resolve/unresolve a comment thread " +
    "(root only, any org member may toggle it).",
  annotations: {
    title: "Update Task Comment",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: z.string(),
    body: z.string().trim().min(1).max(MAX_COMMENT_BODY_LENGTH).optional(),
    resolved: z.boolean().optional(),
  }),
  outputSchema: z.object({ comment: TaskBoardCommentSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = requireOrg(ctx);
    const existing =
      input.body !== undefined
        ? await ctx.storage.taskBoard.getComment(input.id, organizationId)
        : null;
    const taskRun = taskRunContextStore.getStore();
    const orgSlug = ctx.organization?.slug;
    // A run acts under its assigner's credential, so it can edit that person's
    // comments, which it listed with sandbox paths.
    const body =
      input.body !== undefined && taskRun?.threadId && orgSlug
        ? bodyFromRun(input.body, taskRun.threadId, orgSlug)
        : input.body;
    const comment = await ctx.storage.taskBoard.updateComment({
      id: input.id,
      organizationId,
      callerId: getUserId(ctx)!,
      body,
      resolved: input.resolved,
    });
    if (!comment) {
      throw new Error(
        "Comment not found, or you can only edit your own comments",
      );
    }
    // Notify only mentions this edit added, same as an edited description.
    if (
      input.body !== undefined &&
      comment.body !== existing?.body &&
      comment.audience === "human"
    ) {
      await ctx.storage.notifications.notifyMentions({
        taskBoardItemId: comment.taskBoardItemId,
        organizationId,
        actorId: getUserId(ctx)!,
        body: comment.body,
        previousBody: existing?.body ?? null,
      });
    }
    return { comment };
  },
});

export const TASK_BOARD_COMMENT_DELETE = defineTool({
  name: "TASK_BOARD_COMMENT_DELETE",
  description:
    "Delete your own comment. Deleting a thread root deletes its replies too.",
  annotations: {
    title: "Delete Task Comment",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ success: z.boolean() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const deleted = await ctx.storage.taskBoard.deleteComment(
      input.id,
      requireOrg(ctx),
      getUserId(ctx)!,
    );
    return { success: deleted };
  },
});
