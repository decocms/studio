import { Hono } from "hono";
import { z } from "zod";
import type { StudioContext } from "@/core/studio-context";
import { SUPER_AGENT_ASSIGNEE_ID } from "@/shared/task-board";
import { reactToSuperAgentDelegation } from "@/tools/task-board/enqueue-super-agent";
import { emitTaskBoardUpdated } from "@/tools/task-board/run-reactions";
import { TaskBoardItemPrioritySchema } from "@/tools/task-board/schema";
import { bearerToken, isVaultServiceToken } from "./credential-vault";

/**
 * Internal task-board import — a trusted machine service (commerce-discovery's
 * diagnostic worker) batch-creates task board items for the org at the end of
 * an enriched report run.
 *
 *   POST /api/:org/internal/task-board/import
 *
 * Auth mirrors the credential vault's service lease: the shared
 * VAULT_SERVICE_TOKEN bearer alone authenticates (constant-time compare), and
 * the org resolved from the path is the only bound. Like the vault path, the
 * caller holds the org *id*, so resolve-org-from-path also matches this route
 * in its resolve-by-id allowlist.
 *
 * The import AUTO-ENABLES the org's task board once the batch validates: the
 * report push is typically the org's first contact with the board, and the
 * disabled default would otherwise silently drop every task (nobody flips a
 * setting they've never seen). A malformed/rejected request never flips it on
 * with nothing to show for it. Items land as status "triage" with
 * `created_by = "system"` (the established sentinel for non-user principals).
 * `source` is accepted for observability / future dedup and not persisted yet.
 *
 * An item may carry `assigneeId` — a real org member, or the Super Agent
 * sentinel to queue the task for an agent run (status forced to To Do, same as
 * the create tool). A delegated run must execute as a REAL org member
 * (`threads.created_by` is FK'd to `user.id`, and the harness's context
 * factory rejects non-members), so the org's owner stands in as `assigned_by`
 * until the Deco service user exists.
 */

type Variables = {
  studioContext: StudioContext;
};

export const importBodySchema = z.object({
  items: z
    .array(
      z.object({
        title: z.string().min(1).max(500),
        description: z.string().max(4000).nullable().optional(),
        priority: TaskBoardItemPrioritySchema.optional(),
        assigneeId: z.string().nullable().optional(),
      }),
    )
    .min(1)
    .max(100),
  source: z
    .object({
      url: z.string().max(500),
      run_id: z.string().max(200).optional(),
    })
    .optional(),
});

export const createTaskBoardImportRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  app.post("/internal/task-board/import", async (c) => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token || !isVaultServiceToken(token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const ctx = c.get("studioContext");
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      return c.json({ error: "Organization context required" }, 403);
    }

    const parsed = importBodySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", issues: parsed.error.issues },
        400,
      );
    }
    const items = parsed.data.items;

    // Validate real-member assignees against the member table directly — the
    // create tool's assertValidAssignee goes through boundAuth, which needs a
    // user session this service-token route doesn't have.
    for (const item of items) {
      if (!item.assigneeId || item.assigneeId === SUPER_AGENT_ASSIGNEE_ID)
        continue;
      const member = await ctx.db
        .selectFrom("member")
        .select(["id"])
        .where("organizationId", "=", organizationId)
        .where("userId", "=", item.assigneeId)
        .executeTakeFirst();
      if (!member) {
        return c.json(
          { error: `assignee is not a member: ${item.assigneeId}` },
          400,
        );
      }
    }

    // A Super Agent delegation needs a real-member principal for its run —
    // resolve the org's (first) owner once. A live org always has one; if it
    // somehow doesn't, assigned_by stays null and the enqueue fails inside
    // reactToSuperAgentDelegation's best-effort catch (logged, task and batch
    // preserved) — same degradation as an org with no model configured.
    let ownerId: string | null = null;
    if (items.some((i) => i.assigneeId === SUPER_AGENT_ASSIGNEE_ID)) {
      const owner = await ctx.db
        .selectFrom("member")
        .select(["userId"])
        .where("organizationId", "=", organizationId)
        .where("role", "=", "owner")
        .orderBy("createdAt", "asc")
        .executeTakeFirst();
      ownerId = owner?.userId ?? null;
    }

    // Auto-enable: the tasks ARE the org's introduction to the board. Done
    // only once the batch is known-valid, so a malformed/rejected request
    // never flips the setting on with nothing to show for it. The upsert only
    // touches task_board_enabled (absent fields are skipped on conflict), so
    // existing org settings are never clobbered.
    await ctx.storage.organizationSettings.upsert(organizationId, {
      task_board_enabled: true,
    });

    let created = 0;
    let delegated = 0;
    for (const item of items) {
      const toSuperAgent = item.assigneeId === SUPER_AGENT_ASSIGNEE_ID;
      const row = await ctx.storage.taskBoard.create({
        organizationId,
        title: item.title,
        description: item.description ?? null,
        // A task handed to the Super Agent is queued to run — land it in To Do.
        status: toSuperAgent ? "todo" : undefined,
        priority: item.priority,
        assigneeId: item.assigneeId ?? null,
        // The delegation principal: the run executes as this user, so the
        // Super Agent case pins the org owner; a plain member assignment keeps
        // the honest non-user sentinel.
        assignedBy: toSuperAgent ? ownerId : item.assigneeId ? "system" : null,
        by: "system",
      });
      created++;
      // Broadcast each imported card so open boards fill in live.
      emitTaskBoardUpdated(organizationId, row);
      if (toSuperAgent) {
        delegated++;
        await reactToSuperAgentDelegation(ctx, row);
      }
    }

    return c.json({ created, delegated });
  });

  return app;
};
