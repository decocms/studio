/**
 * Organization Billing Storage — the org's billing identity
 * (organization_billing): Stripe customer/subscription binding, status and
 * period end. Platform-written only: the Stripe webhook is the source-of-truth
 * writer; no org-member-facing write goes anywhere near this table.
 */

import type { Kysely, Selectable } from "kysely";
import type { Database } from "./types";

function toBillingRow(
  row: Selectable<Database["organization_billing"]>,
): OrganizationBillingRow {
  return {
    organizationId: row.organization_id,
    legacy: row.legacy,
    status: row.status,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    currentPeriodEnd: row.current_period_end,
    lastStripeEventAt: row.last_stripe_event_at,
  };
}

export interface OrganizationBillingRow {
  organizationId: string;
  /** Orgs predating billing — permanently exempt from any paywall. */
  legacy: boolean;
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

  /** Resolve the org behind a Stripe subscription (webhook events carry
   *  Stripe ids, not ours; the unique index guarantees at most one org per
   *  subscription). */
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

  /**
   * Platform write from the Stripe webhook handlers: subscription identity /
   * status / period end, plus the event high-water mark — ONE row update.
   * Never touches legacy — webhooks only ever narrate what Stripe already
   * committed.
   */
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
}
