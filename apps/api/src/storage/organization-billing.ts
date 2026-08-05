/**
 * Organization Billing Storage — Stripe customer/subscription binding,
 * status, period end. Platform-written only (the webhook is the writer).
 */

import type { Kysely, Selectable } from "kysely";
import type { Database } from "./types";

function toBillingRow(
  row: Selectable<Database["organization_billing"]>,
): OrganizationBillingRow {
  return {
    organizationId: row.organization_id,
    status: row.status,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    currentPeriodEnd: row.current_period_end,
    lastStripeEventAt: row.last_stripe_event_at,
  };
}

export interface OrganizationBillingRow {
  organizationId: string;
  status: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: Date | null;
  /** Newest applied Stripe event's `created` time — the webhook skips
   *  deliveries older than this so out-of-order events can't regress state. */
  lastStripeEventAt: Date | null;
}

export class OrganizationBillingStorage {
  constructor(private db: Kysely<Database>) {}

  async getBilling(
    organizationId: string,
  ): Promise<OrganizationBillingRow | null> {
    const row = await this.db
      .selectFrom("organization_billing")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    return row ? toBillingRow(row) : null;
  }

  /** Resolve the org behind a Stripe subscription id (unique-indexed). */
  async getBillingByStripeSubscriptionId(
    stripeSubscriptionId: string,
  ): Promise<OrganizationBillingRow | null> {
    const row = await this.db
      .selectFrom("organization_billing")
      .selectAll()
      .where("stripe_subscription_id", "=", stripeSubscriptionId)
      .executeTakeFirst();
    return row ? toBillingRow(row) : null;
  }

  /** Webhook write: subscription identity / status / period end + the event
   *  high-water mark, in one row update. */
  async updateStripeState(
    organizationId: string,
    patch: {
      stripeCustomerId?: string;
      /** null = unbind (subscription deleted). */
      stripeSubscriptionId?: string | null;
      status?: string;
      currentPeriodEnd?: Date | null;
      lastStripeEventAt?: Date;
    },
  ): Promise<boolean> {
    const result = await this.db
      .updateTable("organization_billing")
      .set({
        ...(patch.stripeCustomerId !== undefined && {
          stripe_customer_id: patch.stripeCustomerId,
        }),
        ...(patch.stripeSubscriptionId !== undefined && {
          stripe_subscription_id: patch.stripeSubscriptionId,
        }),
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.currentPeriodEnd !== undefined && {
          current_period_end: patch.currentPeriodEnd,
        }),
        ...(patch.lastStripeEventAt !== undefined && {
          last_stripe_event_at: patch.lastStripeEventAt,
        }),
        updated_at: new Date(),
      })
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    return (result.numUpdatedRows ?? 0n) > 0n;
  }

  // Task-execution quota claims (billing/task-quota.ts): one row per
  // reports-pushed task ever dispatched; period_key buckets the count.

  /** This task's claim (run tally + charge state), or null when unclaimed. */
  async taskClaim(
    taskBoardItemId: string,
  ): Promise<{ runCount: number; state: string } | null> {
    const row = await this.db
      .selectFrom("task_quota_claims")
      .select(["run_count", "state"])
      .where("task_board_item_id", "=", taskBoardItemId)
      .executeTakeFirst();
    return row ? { runCount: row.run_count, state: row.state } : null;
  }

  /** Claims charged against a period — the ONE definition of "counts"
   *  (released ones were refunded), shared by the read and the claim
   *  transaction so the two can never drift. */
  private static liveClaimCount(
    db: Kysely<Database>,
    organizationId: string,
    periodKey: string,
  ): Promise<number> {
    return db
      .selectFrom("task_quota_claims")
      .select((eb) => eb.fn.countAll().as("count"))
      .where("organization_id", "=", organizationId)
      .where("period_key", "=", periodKey)
      .where("state", "<>", "released")
      .executeTakeFirst()
      .then((row) => Number(row?.count ?? 0));
  }

  async countTaskClaims(
    organizationId: string,
    periodKey: string,
  ): Promise<number> {
    return await OrganizationBillingStorage.liveClaimCount(
      this.db,
      organizationId,
      periodKey,
    );
  }

  /**
   * Atomic claim-under-limit: locks the org's billing row (FOR UPDATE) so
   * concurrent claims for the SAME org serialize — a burst of N parallel
   * dispatches can never read the same stale count and all pass (the
   * quota-cheat vector). Claims are rare events; the per-org lock is held
   * for three indexed statements.
   *
   * The lock ANCHOR must exist or `FOR UPDATE` locks zero rows and the
   * serialization silently degrades — so the billing row is self-healed
   * first (orgs whose creation-time seed failed have none).
   *
   * A dispatch CHARGES (state `held`, counted); `releaseTaskClaim` refunds it
   * only when the run demonstrably produced nothing. A released claim keeps
   * its `run_count`, so re-dispatching it re-takes a slot but can never reset
   * the per-task cap.
   *
   * Outcomes:
   *  - "claimed": a fresh (or re-charged) claim consumed a period slot;
   *  - "rerun": the task was already charged and its run_count incremented
   *    (review bounces / conflict resolutions cost nothing extra);
   *  - "runs_exhausted": the task's own run_count hit `maxRunsPerTask` — one
   *    claim must not fund unlimited dispatches (re-delegation loop);
   *  - "exhausted": the period bucket is full.
   */
  async claimTaskUnderLimit(
    organizationId: string,
    taskBoardItemId: string,
    periodKey: string,
    limit: number,
    maxRunsPerTask: number,
  ): Promise<"claimed" | "rerun" | "runs_exhausted" | "exhausted"> {
    return await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("organization_billing")
        .values({ organization_id: organizationId })
        .onConflict((oc) => oc.column("organization_id").doNothing())
        .execute();
      await trx
        .selectFrom("organization_billing")
        .select("organization_id")
        .where("organization_id", "=", organizationId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const existing = await trx
        .selectFrom("task_quota_claims")
        .select(["run_count", "state"])
        .where("task_board_item_id", "=", taskBoardItemId)
        .executeTakeFirst();
      // The per-task cap is checked FIRST and against the persisted tally, so
      // a refunded claim can't be looped for free dispatches.
      if (existing && existing.run_count >= maxRunsPerTask) {
        return "runs_exhausted";
      }
      const countedForPeriod = () =>
        OrganizationBillingStorage.liveClaimCount(
          trx,
          organizationId,
          periodKey,
        );
      if (existing && existing.state !== "released") {
        await trx
          .updateTable("task_quota_claims")
          .set({ run_count: existing.run_count + 1 })
          .where("task_board_item_id", "=", taskBoardItemId)
          .execute();
        return "rerun";
      }
      if ((await countedForPeriod()) >= limit) return "exhausted";
      if (existing) {
        // Re-charge a refunded claim: it takes a slot again (under the
        // CURRENT period's key) while the run tally carries over.
        await trx
          .updateTable("task_quota_claims")
          .set({
            state: "held",
            period_key: periodKey,
            run_count: existing.run_count + 1,
          })
          .where("task_board_item_id", "=", taskBoardItemId)
          .execute();
        return "claimed";
      }
      await trx
        .insertInto("task_quota_claims")
        .values({
          task_board_item_id: taskBoardItemId,
          organization_id: organizationId,
          period_key: periodKey,
          state: "held",
        })
        .execute();
      return "claimed";
    });
  }

  /** Refund a charged claim: the run produced nothing (see the single
   *  decision site in tools/task-board/run-reactions.ts). Org-scoped so the
   *  invariant doesn't rest on every future caller passing a scoped id.
   *  Idempotent; `run_count` is left intact on purpose, so a refund can't be
   *  looped into free dispatches. */
  async releaseTaskClaim(
    organizationId: string,
    taskBoardItemId: string,
  ): Promise<void> {
    await this.db
      .updateTable("task_quota_claims")
      .set({ state: "released" })
      .where("organization_id", "=", organizationId)
      .where("task_board_item_id", "=", taskBoardItemId)
      .where("state", "=", "held")
      .execute();
  }

  /**
   * Undo a claim whose dispatch never started. Frees the slot AND rolls the run
   * tally back — unlike a refund, where the run DID happen and only produced
   * nothing, so its tally has to stand. Nothing ran here, so nothing may be
   * spent: a task whose dispatch keeps failing (no model configured) would
   * otherwise burn its per-task cap and die with a quota error for runs that
   * never existed.
   */
  async rollbackTaskClaim(
    organizationId: string,
    taskBoardItemId: string,
  ): Promise<void> {
    await this.db
      .updateTable("task_quota_claims")
      .set((eb) => ({
        state: "released",
        run_count: eb("run_count", "-", 1),
      }))
      .where("organization_id", "=", organizationId)
      .where("task_board_item_id", "=", taskBoardItemId)
      .where("state", "=", "held")
      .execute();
  }
}
