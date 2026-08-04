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

  async hasTaskClaim(taskBoardItemId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("task_quota_claims")
      .select("task_board_item_id")
      .where("task_board_item_id", "=", taskBoardItemId)
      .executeTakeFirst();
    return !!row;
  }

  async countTaskClaims(
    organizationId: string,
    periodKey: string,
  ): Promise<number> {
    const row = await this.db
      .selectFrom("task_quota_claims")
      .select((eb) => eb.fn.countAll().as("count"))
      .where("organization_id", "=", organizationId)
      .where("period_key", "=", periodKey)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  /** Idempotent per task (PK) — a concurrent double-dispatch of the same
   *  task claims once. */
  async claimTask(
    organizationId: string,
    taskBoardItemId: string,
    periodKey: string,
  ): Promise<void> {
    await this.db
      .insertInto("task_quota_claims")
      .values({
        task_board_item_id: taskBoardItemId,
        organization_id: organizationId,
        period_key: periodKey,
      })
      .onConflict((oc) => oc.column("task_board_item_id").doNothing())
      .execute();
  }
}
