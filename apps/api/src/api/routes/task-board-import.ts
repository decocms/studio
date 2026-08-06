import { TaskQuotaError } from "@/billing/task-quota";
import { Hono } from "hono";
import { z } from "zod";
import type { StudioContext } from "@/core/studio-context";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import { TaskBoardStorage } from "@/storage/task-board";
import type { TaskBoardItem } from "@/storage/types";
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
 * Items land as status "triage" with `created_by = "system"` (the established
 * sentinel for non-user principals).
 *
 * TWO IDEMPOTENCY KEYS, different jobs:
 * - `source.run_id` protects the REQUEST: the whole import runs in one
 *   transaction that first claims (org, run_id) in `task_board_import_runs`;
 *   a replay (the reports worker's payment success page and Stripe webhook
 *   both push, seconds apart) loses the claim and no-ops with
 *   `{deduped: true}`. A FAILED import aborts the claim with it, so the
 *   run_id isn't burned. Absent run_id ⇒ no claim (backward compatible).
 * - `item.externalKey` identifies the FINDING: a key matching an OPEN item
 *   refreshes that item (description/priority — never title/status/assignee,
 *   a human may have touched those) instead of creating a duplicate, so
 *   recurring diagnostic runs converge on the same card. A done item is NOT
 *   matched — a regression creates a fresh card. Refreshes never re-trigger
 *   the Super Agent delegation.
 *   When an item carries NO externalKey, its normalized title stands in as the
 *   finding identity. `externalKey` is optional and at least one real producer
 *   never sends it, so the dedup above was simply never reached: one board
 *   accumulated 8 duplicated findings (19 cards that should have been 8), each
 *   duplicate spawning its own agent run and its own pull request. Matching is
 *   EXACT on the normalized title (case, surrounding and repeated whitespace) —
 *   deliberately not fuzzy, because two findings that differ by a few words are
 *   usually two findings, and wrongly merging them loses one silently.
 *
 * A DISMISSED key (`dismissed_at` set) is skipped and counted in `dismissed`.
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

/**
 * Finding identity for an item that carries no `externalKey`: the title with
 * case and whitespace differences flattened. Nothing more aggressive — see the
 * module docstring on why matching stays exact.
 */
export function normalizeTitleKey(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

export const importBodySchema = z.object({
  items: z
    .array(
      z.object({
        title: z.string().min(1).max(500),
        description: z.string().max(4000).nullable().optional(),
        priority: TaskBoardItemPrioritySchema.optional(),
        assigneeId: z.string().nullable().optional(),
        /** Sender-minted finding identity (e.g. `diag:{domain}:{check_id}`) —
         *  dedups against open items on re-import. */
        externalKey: z.string().min(1).max(200).optional(),
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
    const settings = await ctx.storage.organizationSettings.get(organizationId);
    const autoAssignToSuperAgent =
      settings?.flags?.auto_assign_report_tasks_to_super_agent ?? false;
    const items = parsed.data.items.map((item) =>
      !item.assigneeId && autoAssignToSuperAgent
        ? { ...item, assigneeId: SUPER_AGENT_ASSIGNEE_ID }
        : item,
    );

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

    const runId = parsed.data.source?.run_id;

    // One transaction: claim the run_id, then reconcile the batch. Losing the
    // claim means this exact import already ran (double-fire) — no-op. An
    // abort rolls the claim back with the items, so a failed import can be
    // retried under the same run_id.
    const outcome = await ctx.db.transaction().execute(async (trx) => {
      if (runId) {
        const claim = await trx
          .insertInto("task_board_import_runs")
          .values({ organization_id: organizationId, run_id: runId })
          .onConflict((oc) =>
            oc.columns(["organization_id", "run_id"]).doNothing(),
          )
          .executeTakeFirst();
        if ((claim.numInsertedOrUpdatedRows ?? 0n) === 0n) return null;
      }

      // Open cards get refreshed, done ones don't match, dismissed ones
      // suppress the finding.
      const keys = items.flatMap((i) => i.externalKey ?? []);
      const openByKey = new Map<string, string>();
      const dismissed = new Set<string>();

      // Title-keyed fallback for items with no externalKey. Scoped to the org's
      // non-done cards and only paid for when some item actually lacks a key.
      const openByTitle = new Map<string, string>();
      const dismissedTitles = new Set<string>();
      if (items.some((i) => !i.externalKey)) {
        const rows = await trx
          .selectFrom("task_board_items")
          .select(["id", "title", "status", "dismissed_at"])
          .where("organization_id", "=", organizationId)
          .where((eb) =>
            eb.or([
              eb("dismissed_at", "is not", null),
              eb("status", "!=", "done"),
            ]),
          )
          .execute();
        for (const row of rows) {
          const key = normalizeTitleKey(row.title);
          if (row.dismissed_at) dismissedTitles.add(key);
          else if (row.status !== "done" && !openByTitle.has(key)) {
            openByTitle.set(key, row.id);
          }
        }
      }

      if (keys.length > 0) {
        const rows = await trx
          .selectFrom("task_board_items")
          .select(["id", "external_key", "status", "dismissed_at"])
          .where("organization_id", "=", organizationId)
          .where("external_key", "in", keys)
          .where((eb) =>
            eb.or([
              eb("dismissed_at", "is not", null),
              eb("status", "!=", "done"),
            ]),
          )
          .execute();
        for (const row of rows) {
          if (!row.external_key) continue;
          // Dismissal wins over an open card with the same key.
          if (row.dismissed_at) dismissed.add(row.external_key);
          else if (row.status !== "done")
            openByKey.set(row.external_key, row.id);
        }
      }

      const storage = new TaskBoardStorage(trx);
      const touched: TaskBoardItem[] = [];
      const delegations: TaskBoardItem[] = [];
      let created = 0;
      let updated = 0;
      let skipped = 0;
      for (const item of items) {
        const titleKey = normalizeTitleKey(item.title);
        const isDismissed = item.externalKey
          ? dismissed.has(item.externalKey)
          : dismissedTitles.has(titleKey);
        if (isDismissed) {
          skipped++;
          continue;
        }
        const existingId = item.externalKey
          ? openByKey.get(item.externalKey)
          : openByTitle.get(titleKey);
        if (existingId) {
          // Refresh the finding's card: new evidence + severity. Title,
          // status and assignee stay — a human may have touched them, and a
          // refresh must never re-queue a delegation.
          touched.push(
            await storage.update(
              existingId,
              organizationId,
              {
                description: item.description ?? null,
                priority: item.priority,
              },
              "system",
            ),
          );
          updated++;
          continue;
        }
        const toSuperAgent = item.assigneeId === SUPER_AGENT_ASSIGNEE_ID;
        const row = await storage.create({
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
          assignedBy: toSuperAgent
            ? ownerId
            : item.assigneeId
              ? "system"
              : null,
          externalKey: item.externalKey ?? null,
          by: "system",
        });
        // A within-batch duplicate key folds into the row just created.
        if (item.externalKey) openByKey.set(item.externalKey, row.id);
        else openByTitle.set(titleKey, row.id);
        touched.push(row);
        created++;
        if (toSuperAgent) delegations.push(row);
      }
      return { touched, delegations, created, updated, skipped };
    });

    if (!outcome)
      return c.json({ created: 0, updated: 0, delegated: 0, deduped: true });

    // Side effects only after commit — a rolled-back import must not
    // broadcast cards or enqueue agent runs.
    for (const row of outcome.touched)
      emitTaskBoardUpdated(organizationId, row);
    // A paywalled delegation must not leave the card looking delegated with
    // no run behind it: un-assign it (the user sees the paywall when they
    // delegate it themselves) and report it apart from the ones that ran.
    let delegated = 0;
    let quotaBlocked = 0;
    for (const row of outcome.delegations) {
      try {
        await reactToSuperAgentDelegation(ctx, row);
        delegated++;
      } catch (err) {
        if (!(err instanceof TaskQuotaError)) throw err;
        quotaBlocked++;
        await new TaskBoardStorage(ctx.db)
          .update(row.id, organizationId, { assigneeId: null }, "system")
          .then((updated) => emitTaskBoardUpdated(organizationId, updated))
          .catch((undoErr: unknown) => {
            console.error("[task-board-import] un-delegate failed", undoErr);
          });
      }
    }

    return c.json({
      created: outcome.created,
      updated: outcome.updated,
      delegated,
      // Report the skips — a silent one reads as "imported everything".
      ...(outcome.skipped > 0 && { dismissed: outcome.skipped }),
      ...(quotaBlocked > 0 && { quota_blocked: quotaBlocked }),
    });
  });

  return app;
};
