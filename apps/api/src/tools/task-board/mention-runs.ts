/**
 * A person talking to the Super Agent from a card's comments: the built-in
 * "Super Agent mentions".
 *
 * Each run is a comment thread. The comment that started it carries the run's
 * `threadId`, the agent replies under it (see `runCommentParent`), and a
 * reply in the thread goes to the run. One run works a card at a time:
 *
 * - a mention with a run in progress goes to that run, in its thread;
 * - a mention with none starts one;
 * - a reply in a finished run's thread resumes that run, unless another run is
 *   working the card, which refuses the reply.
 *
 * A new run starts as a fire of the built-in, through the fire workflow's card
 * step (`card-run.ts`), like every board run.
 */

import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import { parseMentions } from "@decocms/shared/mentions";
import {
  builtinActive,
  ensureBuiltinAutomations,
  MENTIONS_SYSTEM_KEY,
} from "@/automations/builtin";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { TaskQuotaError } from "@/billing/task-quota";
import {
  enqueueAutomationFire,
  fireAutomationDirect,
} from "@/automations/dbos-sync";
import type { FireAutomationContext } from "@/automations/dbos-workflow";
import { getUserId, type StudioContext } from "@/core/studio-context";
import type { TaskBoardComment } from "@/storage/task-board";
import type { TaskBoardItem } from "@/storage/types";
import { sendCommentToRun } from "./comment-to-run";

type ItemThread = TaskBoardItem["threads"][number];
type CommentRef = Pick<
  TaskBoardComment,
  "id" | "parentId" | "threadId" | "authorId"
>;

/** Where a comment for the Super Agent goes, decided before it is written. */
export type MentionPlan =
  /** Start a run. `tie` is the comment the run's thread hangs off: an
   *  existing root, or (null) the comment being written. */
  | { kind: "start"; tie: string | null }
  /** Send the comment to a run's thread. `parentId` is where the comment is
   *  written; `tieNew` ties the new comment to the run, for a run no comment
   *  had started (a board run). */
  | {
      kind: "send";
      threadId: string;
      parentId: string | null;
      tieNew: boolean;
    };

/** A run still working: running, or waiting on a person. */
function isLive(thread: ItemThread): boolean {
  return (
    thread.failureKind !== "superseded" &&
    (thread.status === "in_progress" || thread.status === "requires_action")
  );
}

/** The person's comment a run's thread hangs off, if any. */
function personRootOf(comments: CommentRef[], runThreadId: string) {
  return comments.find(
    (c) =>
      !c.parentId &&
      c.threadId === runThreadId &&
      c.authorId !== SUPER_AGENT_ASSIGNEE_ID,
  );
}

/**
 * Decide where a person's comment goes, or null for a plain comment. Throws
 * when the comment would start a second run on a card one is working.
 */
export function routeComment(
  item: Pick<TaskBoardItem, "threads">,
  comments: CommentRef[],
  input: { body: string; parentId?: string | null },
): MentionPlan | null {
  const live = item.threads.find(isLive);
  const linked = new Set(item.threads.map((t) => t.threadId));
  const parent = input.parentId
    ? comments.find((c) => c.id === input.parentId)
    : undefined;
  const root = parent?.parentId
    ? comments.find((c) => c.id === parent.parentId)
    : parent;
  const rootRun =
    root?.threadId && linked.has(root.threadId) ? root.threadId : null;

  // A reply in a run's thread is for the run, @ or not.
  if (root && rootRun) {
    if (live && live.threadId !== rootRun) {
      throw new Error(
        "Another run is working on this card. Reply in its thread, or wait for it to finish.",
      );
    }
    return {
      kind: "send",
      threadId: rootRun,
      parentId: input.parentId ?? null,
      tieNew: false,
    };
  }

  if (!parseMentions(input.body).includes(SUPER_AGENT_ASSIGNEE_ID)) {
    return null;
  }

  if (live) {
    const parentId =
      input.parentId ?? personRootOf(comments, live.threadId)?.id ?? null;
    return {
      kind: "send",
      threadId: live.threadId,
      parentId,
      tieNew: parentId === null,
    };
  }

  // A mention inside another conversation makes that conversation the run's.
  return { kind: "start", tie: root && !root.threadId ? root.id : null };
}

/** Read the card's comments and route `input`, or null when the built-in is
 *  off or the comment is not for the Super Agent. */
export async function planMention(
  ctx: StudioContext,
  item: TaskBoardItem,
  input: { body: string; parentId?: string | null },
): Promise<MentionPlan | null> {
  if (!(await builtinActive(ctx, item.organizationId, MENTIONS_SYSTEM_KEY))) {
    return null;
  }
  const comments = await ctx.storage.taskBoard.listComments(
    item.id,
    item.organizationId,
  );
  return routeComment(item, comments, input);
}

function authorName(ctx: StudioContext): string {
  return ctx.auth?.user?.name?.trim() || "A teammate";
}

/**
 * Carry out `plan` for `comment`, already written: send it to the run it is
 * for, or fire the built-in to start one. Throws what refused the run, so the
 * caller can take the comment back.
 */
export async function runMention(
  ctx: StudioContext,
  item: TaskBoardItem,
  comment: TaskBoardComment,
  plan: MentionPlan,
): Promise<void> {
  const forRun = {
    commentId: comment.id,
    body: comment.body,
    authorId: getUserId(ctx)!,
    authorName: authorName(ctx),
    rootId: comment.parentId ?? comment.id,
  };

  if (plan.kind === "send") {
    await sendCommentToRun(ctx, item, plan.threadId, forRun);
    if (plan.tieNew) {
      await ctx.storage.taskBoard.setCommentThread(
        comment.id,
        item.organizationId,
        plan.threadId,
      );
    }
    return;
  }

  const { automationId, triggerId } = await mentionsTrigger(ctx, item);
  const latest = [...item.threads].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )[0];
  const fire: FireAutomationContext = {
    automationId,
    organizationId: item.organizationId,
    triggerId,
    target: {
      kind: "card",
      itemId: item.id,
      columnKey: item.status,
      // Keyed on the card's latest run: two mentions racing start one run.
      eventKey: `mention:${item.id}:${latest?.threadId ?? "first"}`,
      movedBy: forRun.authorId,
      mention: { ...forRun, tieId: plan.tie ?? comment.id },
    },
  };
  const idempotencyKey = `mention:${comment.id}`;
  if (DBOS.isWithinWorkflow()) {
    await enqueueAutomationFire(fire, { idempotencyKey });
    return;
  }
  const outcome = await fireAutomationDirect(fire, { idempotencyKey });
  if ("skipped" in outcome) {
    const { quotaReason, message } = outcome.error ?? {
      message: `The run did not start (${outcome.skipped}).`,
    };
    throw quotaReason ? new TaskQuotaError(quotaReason) : new Error(message);
  }
}

/** The org's "Super Agent mentions" trigger, seeding it for an org the boot
 *  seed has not reached. */
async function mentionsTrigger(
  ctx: StudioContext,
  item: TaskBoardItem,
): Promise<{ automationId: string; triggerId: string }> {
  const found = await ctx.storage.automations.findBuiltinTrigger(
    item.organizationId,
    MENTIONS_SYSTEM_KEY,
  );
  if (found) return found;
  await ensureBuiltinAutomations(ctx.db, {
    id: item.organizationId,
    createdBy: getUserId(ctx) ?? item.createdBy,
  });
  const seeded = await ctx.storage.automations.findBuiltinTrigger(
    item.organizationId,
    MENTIONS_SYSTEM_KEY,
  );
  if (!seeded) throw new Error("This organization has no Super Agent mentions");
  return seeded;
}

/**
 * Where a comment a run writes without a parent goes: under the person's
 * comment that started or speaks to the run, so the agent answers in that
 * thread. Null when no comment is tied to the run.
 */
export function runCommentParent(
  comments: CommentRef[],
  runThreadId: string,
): string | null {
  return personRootOf(comments, runThreadId)?.id ?? null;
}
