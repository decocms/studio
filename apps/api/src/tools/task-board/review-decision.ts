import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";
import type { StudioContext } from "@/core/studio-context";
import {
  REVIEWER_FLAG,
  REVIEWER_KINDS,
  REVIEWER_LABEL,
  type ReviewerKind,
} from "@decocms/shared/task-board";
import { TaskBoardItemStatusSchema } from "./schema";
import { recordTaskActivity } from "./activity";
import { emitTaskBoardUpdated } from "./run-reactions";
import { enqueueSuperAgentForTask } from "./enqueue-super-agent";
import { mergeLinkedPr } from "./merge-pr";

/**
 * True when EVERY enabled reviewer has an `approve` as its latest decision in
 * the current review cycle (since the task last entered In Review), with none
 * outstanding. Reads the activity log — the single record of each reviewer's
 * verdict — so it's robust across the two reviewers finishing in any order.
 */
async function allEnabledReviewersApproved(
  ctx: StudioContext,
  orgId: string,
  taskBoardItemId: string,
): Promise<boolean> {
  const settings = await ctx.storage.organizationSettings.get(orgId);
  const flags = settings?.flags ?? {};
  const enabled = REVIEWER_KINDS.filter(
    (k) => flags[REVIEWER_FLAG[k]] === true,
  );
  if (enabled.length === 0) return false;

  const activity = await ctx.storage.taskBoard.listActivity(
    taskBoardItemId,
    orgId,
  );
  let lastInReviewAt = 0;
  for (const a of activity) {
    if (
      a.action === "status_changed" &&
      (a.data as { to?: unknown })?.to === "in_review"
    ) {
      lastInReviewAt = Math.max(
        lastInReviewAt,
        new Date(a.occurredAt).getTime(),
      );
    }
  }

  // Latest verdict per reviewer within this cycle.
  const latest = new Map<ReviewerKind, "approved" | "changes_requested">();
  for (const a of activity) {
    if (
      a.action !== "review_approved" &&
      a.action !== "review_changes_requested"
    )
      continue;
    if (new Date(a.occurredAt).getTime() < lastInReviewAt) continue;
    const reviewer = (a.data as { reviewer?: unknown })?.reviewer;
    if (reviewer !== "qa" && reviewer !== "code_review") continue;
    latest.set(
      reviewer,
      a.action === "review_approved" ? "approved" : "changes_requested",
    );
  }

  return enabled.every((k) => latest.get(k) === "approved");
}

export const TASK_BOARD_REVIEW_DECISION = defineTool({
  name: "TASK_BOARD_REVIEW_DECISION",
  description:
    "Record a reviewer's decision for a task under review. `approve` marks the " +
    "pull request approved by that reviewer (and, once EVERY enabled reviewer " +
    "has approved, merges it when the org enabled auto-merge, advancing the " +
    "task to Done); `request_changes` hands the task back to the Super Agent " +
    "with your notes so it can fix the PR.",
  annotations: {
    title: "Review Decision",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    // May merge a PR on GitHub.
    openWorldHint: true,
  },
  inputSchema: z.object({
    taskBoardItemId: z.string(),
    reviewer: z
      .enum(["qa", "code_review"])
      .describe(
        "Which reviewer you are: `qa` (QA Agent) or `code_review` (Code Reviewer).",
      ),
    decision: z.enum(["approve", "request_changes"]),
    notes: z
      .string()
      .min(1)
      .describe(
        "For approve: a short summary of what you verified. For " +
          "request_changes: specific, actionable feedback the Super Agent " +
          "must address.",
      ),
  }),
  outputSchema: z.object({
    status: TaskBoardItemStatusSchema,
    merged: z
      .boolean()
      .describe(
        "True when this approval completed the review and merged the PR.",
      ),
  }),
  handler: async ({ taskBoardItemId, reviewer, decision, notes }, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    const item = await ctx.storage.taskBoard.getById(
      taskBoardItemId,
      organizationId,
    );
    if (!item) {
      throw new Error(`Task board item not found: ${taskBoardItemId}`);
    }

    if (decision === "request_changes") {
      // Any reviewer requesting changes bounces the task straight back to the
      // Super Agent with the feedback in its re-run prompt — no need to wait on
      // the other reviewer. Pull it back to In Progress and re-enqueue directly.
      const updated = await ctx.storage.taskBoard.update(
        taskBoardItemId,
        organizationId,
        { status: "in_progress" },
        item.updatedBy,
      );
      await recordTaskActivity(ctx, {
        taskBoardItemId,
        action: "review_changes_requested",
        actorId: null,
        data: { reviewer, notes },
      });
      emitTaskBoardUpdated(organizationId, updated);
      // Pass the PR under review so the re-run updates it in place (checks out
      // its branch) instead of opening a second PR. Newest linked PR is the one.
      const prs = await ctx.storage.taskBoard.listPrs(
        taskBoardItemId,
        organizationId,
      );
      const pr = prs[0];
      await enqueueSuperAgentForTask(ctx, updated, {
        feedback: `${REVIEWER_LABEL[reviewer]}: ${notes}`,
        pr: pr ? { number: pr.number, url: pr.url } : undefined,
      });
      return { status: updated.status, merged: false };
    }

    // approve — record first so the all-approved check below sees this verdict.
    await recordTaskActivity(ctx, {
      taskBoardItemId,
      action: "review_approved",
      actorId: null,
      data: { reviewer, notes },
    });

    // Only the LAST enabled reviewer to approve completes the review. Until then
    // the task waits In Review for the other reviewer.
    const complete = await allEnabledReviewersApproved(
      ctx,
      organizationId,
      taskBoardItemId,
    );
    if (!complete) {
      const refreshed =
        (await ctx.storage.taskBoard.getById(
          taskBoardItemId,
          organizationId,
        )) ?? item;
      emitTaskBoardUpdated(organizationId, refreshed);
      return { status: refreshed.status, merged: false };
    }

    const settings = await ctx.storage.organizationSettings.get(organizationId);
    const autoMerge = settings?.flags?.auto_merge === true;
    const merged = autoMerge
      ? await mergeLinkedPr(ctx, organizationId, taskBoardItemId)
      : false;

    // A merge ships the task → Done. Without a merge, leave it In Review for a
    // human to merge.
    const updated = merged
      ? await ctx.storage.taskBoard.update(
          taskBoardItemId,
          organizationId,
          { status: "done" },
          item.updatedBy,
        )
      : ((await ctx.storage.taskBoard.getById(
          taskBoardItemId,
          organizationId,
        )) ?? item);
    if (merged) {
      await recordTaskActivity(ctx, {
        taskBoardItemId,
        action: "status_changed",
        actorId: null,
        data: { from: item.status, to: "done" },
      });
    }
    emitTaskBoardUpdated(organizationId, updated);
    return { status: updated.status, merged };
  },
});
