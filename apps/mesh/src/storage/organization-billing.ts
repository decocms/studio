/**
 * Organization Billing Storage
 *
 * Per-seat billing state: the org's billing identity (organization_billing),
 * paid-seat membership (organization_paid_seat, presence = paid) and the
 * append-only seat_change_log. Platform-written only — no org-member-facing
 * write goes anywhere near organization_billing except through the seat
 * tools, which gate on billing_mode.
 */

import type { Kysely } from "kysely";
import type { Database } from "./types";

export interface OrganizationBillingRow {
  organizationId: string;
  legacy: boolean;
  billingMode: string;
  status: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: Date | null;
  includedReportUrl: string | null;
}

export type SeatKind = "paid" | "free";

export interface SeatChange {
  userId: string;
  seat: SeatKind;
}

export interface SetSeatsResult {
  /** Transitions actually applied (no-ops — already in the target state —
   *  are skipped and NOT logged, so the invoiced change-log stays clean). */
  applied: SeatChange[];
  paidSeatCount: number;
}

export class SeatTargetNotMemberError extends Error {
  constructor(userIds: string[]) {
    super(`not members of this organization: ${userIds.join(", ")}`);
    this.name = "SeatTargetNotMemberError";
  }
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
    if (!row) return null;
    return {
      organizationId: row.organization_id,
      legacy: row.legacy,
      billingMode: row.billing_mode,
      status: row.status,
      stripeCustomerId: row.stripe_customer_id,
      stripeSubscriptionId: row.stripe_subscription_id,
      currentPeriodEnd: row.current_period_end,
      includedReportUrl: row.included_report_url,
    };
  }

  async listPaidSeatUserIds(organizationId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("organization_paid_seat")
      .select(["user_id"])
      .where("organization_id", "=", organizationId)
      .execute();
    return rows.map((r) => r.user_id);
  }

  /**
   * Apply seat transitions atomically: paid-seat rows and their change-log
   * entries commit together (the log is the invoiced orgs' billing source —
   * they must never diverge). Every target must be a CURRENT org member;
   * unknown users reject the whole batch (SeatTargetNotMemberError) so a
   * stale UI can't silently bill a ghost. Idempotent per state: setting a
   * seat to the state it's already in applies nothing and logs nothing.
   */
  async setSeats(
    organizationId: string,
    changes: SeatChange[],
    changedBy: string,
  ): Promise<SetSeatsResult> {
    return await this.db.transaction().execute(async (trx) => {
      const userIds = [...new Set(changes.map((c) => c.userId))];
      if (userIds.length !== changes.length) {
        throw new Error("duplicate userId in seat changes");
      }
      if (userIds.length > 0) {
        const members = await trx
          .selectFrom("member")
          .select(["userId"])
          .where("organizationId", "=", organizationId)
          .where("userId", "in", userIds)
          .execute();
        const memberIds = new Set(members.map((m) => m.userId));
        const unknown = userIds.filter((id) => !memberIds.has(id));
        if (unknown.length > 0) throw new SeatTargetNotMemberError(unknown);
      }

      const applied: SeatChange[] = [];
      for (const change of changes) {
        if (change.seat === "paid") {
          // ON CONFLICT DO NOTHING → zero rows returned when already paid.
          const inserted = await trx
            .insertInto("organization_paid_seat")
            .values({
              organization_id: organizationId,
              user_id: change.userId,
            })
            .onConflict((oc) =>
              oc.columns(["organization_id", "user_id"]).doNothing(),
            )
            .returning("user_id")
            .executeTakeFirst();
          if (inserted) applied.push(change);
        } else {
          const deleted = await trx
            .deleteFrom("organization_paid_seat")
            .where("organization_id", "=", organizationId)
            .where("user_id", "=", change.userId)
            .returning("user_id")
            .executeTakeFirst();
          if (deleted) applied.push(change);
        }
      }

      if (applied.length > 0) {
        await trx
          .insertInto("seat_change_log")
          .values(
            applied.map((c) => ({
              organization_id: organizationId,
              user_id: c.userId,
              seat: c.seat,
              changed_by: changedBy,
            })),
          )
          .execute();
      }

      const paidSeats = await trx
        .selectFrom("organization_paid_seat")
        .select((eb) => eb.fn.countAll().as("count"))
        .where("organization_id", "=", organizationId)
        .executeTakeFirst();

      return { applied, paidSeatCount: Number(paidSeats?.count ?? 0) };
    });
  }

  /**
   * Member left/was removed: release their paid seat (if any) and log the
   * transition — otherwise a removed member's seat keeps counting toward the
   * org's bill forever. Direct ops (not setSeats): the member row is already
   * gone at this point, so setSeats' membership validation would reject it.
   */
  async releaseSeatOnMemberRemoval(
    organizationId: string,
    userId: string,
    changedBy: string,
  ): Promise<boolean> {
    return await this.db.transaction().execute(async (trx) => {
      const deleted = await trx
        .deleteFrom("organization_paid_seat")
        .where("organization_id", "=", organizationId)
        .where("user_id", "=", userId)
        .returning("user_id")
        .executeTakeFirst();
      if (!deleted) return false;
      await trx
        .insertInto("seat_change_log")
        .values({
          organization_id: organizationId,
          user_id: userId,
          seat: "free",
          changed_by: changedBy,
        })
        .execute();
      return true;
    });
  }
}
