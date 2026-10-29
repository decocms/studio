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

  /**
   * The org's billing row, creating the empty one if the creation-time seed
   * never ran. The row is a binding slot, never a fact about the org, so its
   * absence must not decide anything.
   *
   * The webhook needs it because "no row" there meant a PAID checkout was
   * acknowledged and dropped — no plan, no refund, no orphan cleanup.
   *
   * Null only when the org itself does not exist (the foreign key refuses the
   * insert). That IS "unknown org", and it is the one case the caller should
   * still acknowledge and drop: redelivering cannot conjure the organization.
   */
  async ensureBilling(
    organizationId: string,
  ): Promise<OrganizationBillingRow | null> {
    const existing = await this.getBilling(organizationId);
    if (existing) return existing;
    try {
      await this.db
        .insertInto("organization_billing")
        .values({ organization_id: organizationId })
        .onConflict((oc) => oc.column("organization_id").doNothing())
        .execute();
    } catch {
      return null;
    }
    return await this.getBilling(organizationId);
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

  /**
   * Orgs whose paid period ended and whose row nobody has touched since.
   *
   * The reconciliation input. Every other path back to Free is a WEBHOOK, and a
   * webhook is the one part of this system we do not control: Stripe gives up
   * after ~3 days of 5xx and disables an endpoint that keeps failing. Nothing
   * else notices, so a lost `subscription.deleted` left an org holding
   * a paid tier, a funded provider key and every gated feature, permanently.
   *
   * A row that renewed normally has had `current_period_end` pushed forward by
   * `invoice.paid`, so it is not here. Being here means the last thing we heard
   * is older than the period it described.
   *
   * `status <> 'canceled'` because a canceled row has already been reconciled —
   * its period end is simply the last one it had. Ordered oldest-first so a
   * backlog drains deterministically under the tick limit.
   */
  async listSubscriptionsPastPeriodEnd(
    before: Date,
    limit: number,
  ): Promise<OrganizationBillingRow[]> {
    const rows = await this.db
      .selectFrom("organization_billing")
      .selectAll()
      .where("stripe_subscription_id", "is not", null)
      .where("status", "<>", "canceled")
      .where("current_period_end", "is not", null)
      .where("current_period_end", "<", before)
      .orderBy("current_period_end", "asc")
      .limit(limit)
      .execute();
    return rows.map(toBillingRow);
  }

  /** Webhook write: subscription identity / status / period end + the event
   *  high-water mark, in one row update. */
  /**
   * Bind an org to a subscription, but only if nothing else holds the slot.
   *
   * The bind used to be read-then-write: the webhook read the row, saw no
   * subscription, and called `updateStripeState`. Two `checkout.session.completed`
   * deliveries racing for the same org both read null, so NEITHER hit the
   * rebind refusal, both wrote, and the last one won — leaving the other
   * subscription bound to nothing, uncancelled, and billing the customer every
   * month for ever. Silent, because the refusal that exists to catch exactly
   * this never fired.
   *
   * Postgres decides it now. The WHERE makes the slot a compare-and-set:
   * whoever gets there first keeps it, everyone else gets `false` and is
   * handled as an orphan. Re-binding the SAME subscription stays true so a
   * redelivery is not mistaken for a second subscription.
   *
   * @returns false when another subscription already owns the slot.
   */
  async bindSubscription(
    organizationId: string,
    patch: {
      stripeSubscriptionId: string;
      stripeCustomerId?: string;
      status?: string;
      lastStripeEventAt?: Date;
    },
  ): Promise<boolean> {
    const result = await this.db
      .updateTable("organization_billing")
      .set({
        stripe_subscription_id: patch.stripeSubscriptionId,
        ...(patch.stripeCustomerId !== undefined && {
          stripe_customer_id: patch.stripeCustomerId,
        }),
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.lastStripeEventAt !== undefined && {
          last_stripe_event_at: patch.lastStripeEventAt,
        }),
        updated_at: new Date(),
      })
      .where("organization_id", "=", organizationId)
      .where((eb) =>
        eb.or([
          eb("stripe_subscription_id", "is", null),
          eb("stripe_subscription_id", "=", patch.stripeSubscriptionId),
        ]),
      )
      .executeTakeFirst();
    return (result.numUpdatedRows ?? 0n) > 0n;
  }

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
