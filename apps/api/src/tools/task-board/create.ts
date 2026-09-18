import { LANES } from "@decocms/shared/task-board";
import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import {
  getUserId,
  requireAuth,
  type StudioContext,
} from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import {
  MAX_TASK_DESCRIPTION_LENGTH,
  MAX_TASK_REPO_LENGTH,
  MAX_TASK_TITLE_LENGTH,
  SUPER_AGENT_ASSIGNEE_ID,
  TaskBoardItemPrioritySchema,
  TaskBoardItemTypeSchema,
  TaskBoardItemSchema,
  TaskBoardItemStatusSchema,
} from "./schema";
import { assertValidAssignee } from "./validate-assignee";
import { reactToSuperAgentDelegation } from "./enqueue-super-agent";
import { recordTaskActivity } from "./activity";
import { emitTaskBoardUpdated } from "./run-reactions";
import {
  type ChangeRequestRef,
  findChangeRequestIn,
} from "./change-request-extract";
import { findDuplicateTask } from "./duplicate-check";
import { invalidatePrCards } from "./prs-get";
import { rejectsUngatedDeliveryLane } from "./update";

export const TASK_BOARD_ITEM_CREATE = defineTool({
  name: "TASK_BOARD_ITEM_CREATE",
  description: "Create a new task board item for the organization.",
  annotations: {
    title: "Create Task Board Item",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    title: z.string().min(1).max(MAX_TASK_TITLE_LENGTH),
    description: z
      .string()
      .max(MAX_TASK_DESCRIPTION_LENGTH)
      .nullable()
      .optional(),
    status: TaskBoardItemStatusSchema.optional(),
    priority: TaskBoardItemPrioritySchema.optional(),
    type: TaskBoardItemTypeSchema.optional(),
    assigneeId: z.string().nullable().optional(),
    repo: z.string().max(MAX_TASK_REPO_LENGTH).nullable().optional(),
    dueDate: z.string().datetime().nullable().optional(),
    tagIds: z.array(z.string()).max(1000).optional(),
    prUrl: z
      .string()
      .nullable()
      .optional()
      .describe(
        "GitHub pull request URL to link to the new task, e.g. " +
          "https://github.com/owner/repo/pull/123. Pass it right after you " +
          "open a PR so the card lands on the board with its PR already " +
          "attached for review.",
      ),
    onDuplicate: z
      .enum(["create", "return_existing"])
      .optional()
      .describe(
        "What to do when an open card already tracks this work. " +
          "`return_existing` asks a model to compare the draft against the " +
          "board's open cards and, on a confident match, returns that card " +
          "instead of creating one (`deduplicated: true` in the output; a " +
          "`prUrl` is linked to it). Default `create` skips the check. Use " +
          "`return_existing` when filing on someone's behalf — reports, " +
          "chat requests — where the same ask arrives more than once.",
      ),
  }),
  outputSchema: z.object({
    item: TaskBoardItemSchema,
    /** True when `item` is a pre-existing card returned in place of a new one. */
    deduplicated: z.boolean(),
    /** The model's one-line reason for the match; null unless deduplicated. */
    duplicateReason: z.string().nullable(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    // Parse the PR link before any write, so a bad URL fails without orphaning a card.
    const pr = input.prUrl ? findChangeRequestIn(input.prUrl) : null;
    if (input.prUrl && !pr) {
      throw new Error(
        `Not a change request URL: ${input.prUrl} (expected ` +
          "https://github.com/<owner>/<repo>/pull/<number>, " +
          "https://gitlab.com/<namespace>/<project>/-/merge_requests/<iid> or " +
          "https://bitbucket.org/<workspace>/<repo>/pull-requests/<id>)",
      );
    }

    if (input.status !== undefined) {
      const settings =
        await ctx.storage.organizationSettings.get(organizationId);
      if (
        rejectsUngatedDeliveryLane(
          input.status,
          orgFlagEnabled(settings?.flags, "delivery_lanes_enabled"),
        )
      ) {
        throw new Error(
          "Delivery lanes are not enabled for this organization — enable " +
            "them in Settings before creating a task in Approved, Merged, " +
            "or Post-deploy Validation.",
        );
      }
    }

    if (input.assigneeId) {
      await assertValidAssignee(ctx, organizationId, input.assigneeId);
    }

    const delegatedToSuperAgent = input.assigneeId === SUPER_AGENT_ASSIGNEE_ID;
    const status = delegatedToSuperAgent
      ? LANES.queue
      : (input.status ?? LANES.intake);

    if (input.tagIds?.length) {
      const orgTags = await ctx.storage.tags.listOrgTags(organizationId);
      const validTagIds = new Set(orgTags.map((t) => t.id));
      for (const tagId of input.tagIds) {
        if (!validTagIds.has(tagId)) {
          throw new Error(`Tag not found: ${tagId}`);
        }
      }
    }

    if (input.onDuplicate === "return_existing") {
      const duplicate = await findDuplicateTask(ctx, organizationId, {
        title: input.title,
        description: input.description,
        repo: input.repo,
      }).catch((err) => {
        console.error("[task-board] duplicate check failed", err);
        return null;
      });
      if (duplicate) {
        return returnExistingCard(ctx, {
          organizationId,
          existing: duplicate.item,
          reason: duplicate.reason,
          draft: input,
          pr,
        });
      }
    }

    let item = await ctx.storage.taskBoard.create({
      organizationId,
      title: input.title,
      description: input.description ?? null,
      status,
      priority: input.priority,
      type: input.type,
      assigneeId: input.assigneeId ?? null,
      assignedBy: input.assigneeId ? getUserId(ctx)! : null,
      repo: input.repo ?? null,
      dueDate: input.dueDate ?? null,
      by: getUserId(ctx)!,
    });

    if (input.tagIds?.length) {
      await ctx.storage.taskBoard.setItemTags(
        item.id,
        input.tagIds,
        getUserId(ctx)!,
      );
      item = (await ctx.storage.taskBoard.getById(item.id, organizationId))!;
    }

    if (pr) {
      await ctx.storage.taskBoard.linkPr({
        taskBoardItemId: item.id,
        organizationId,
        url: pr.url,
        prNumber: pr.number,
        repo: pr.repo,
        connectionId: null,
      });
      // Drop the cached card so a viewer's next poll shows the new PR, not a stale "no PR" placeholder.
      await invalidatePrCards(organizationId).catch((err) => {
        console.error("[task-board] PR card cache invalidation failed", err);
      });
    }

    await recordTaskActivity(ctx, {
      taskBoardItemId: item.id,
      action: "created",
      actorId: getUserId(ctx)!,
      // The only place an assignee named at create time gets enrolled.
      alsoSubscribe: [
        getUserId(ctx)!,
        item.assigneeId === SUPER_AGENT_ASSIGNEE_ID ? null : item.assigneeId,
      ],
    });

    await ctx.storage.notifications.notifyMentions({
      taskBoardItemId: item.id,
      organizationId,
      actorId: getUserId(ctx)!,
      body: item.description ?? "",
    });

    // Broadcast the new card so every open board adds it live, no polling.
    emitTaskBoardUpdated(organizationId, item);
    await reactToSuperAgentDelegation(ctx, item);

    return { item, deduplicated: false, duplicateReason: null };
  },
});

/**
 * The `return_existing` outcome: the card that already tracks the drafted work
 * stands in for the one that would have been created. The second filing is not
 * lost — it lands on the existing card's timeline (`duplicate_reported`, with
 * the drafted title so a reader sees what was asked the second time), the filer
 * starts following the card, and a `prUrl` handed in is linked to it, since
 * the PR is for that work regardless of which card names it.
 *
 * Nothing else on the existing card changes: no lane move, no reassignment, no
 * description edit. Whoever owns it keeps owning it.
 *
 * The filer is subscribed directly: `duplicate_reported` earns no inbox row,
 * so the activity fan-out does not enroll followers for it.
 */
async function returnExistingCard(
  ctx: StudioContext,
  params: {
    organizationId: string;
    existing: TaskBoardItem;
    reason: string;
    draft: { title: string; description?: string | null };
    pr: ChangeRequestRef | null;
  },
): Promise<{
  item: TaskBoardItem;
  deduplicated: boolean;
  duplicateReason: string | null;
}> {
  const { organizationId, existing, reason, draft, pr } = params;
  const userId = getUserId(ctx)!;

  if (pr) {
    await ctx.storage.taskBoard.linkPr({
      taskBoardItemId: existing.id,
      organizationId,
      url: pr.url,
      prNumber: pr.number,
      repo: pr.repo,
      connectionId: null,
    });
    await invalidatePrCards(organizationId).catch((err) => {
      console.error("[task-board] PR card cache invalidation failed", err);
    });
  }

  await recordTaskActivity(ctx, {
    taskBoardItemId: existing.id,
    action: "duplicate_reported",
    actorId: userId,
    data: { title: draft.title, reason },
  });
  await ctx.storage.notifications
    .setSubscribed(userId, existing.id, true)
    .catch((err) => {
      console.error("[task-board] duplicate filer subscription failed", err);
    });

  const item =
    (await ctx.storage.taskBoard.getById(existing.id, organizationId)) ??
    existing;
  if (pr) emitTaskBoardUpdated(organizationId, item);
  return { item, deduplicated: true, duplicateReason: reason };
}
