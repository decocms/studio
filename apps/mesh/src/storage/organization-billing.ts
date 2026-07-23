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
  /** Non-null = a gateway allowance grant is pending for the latest seat
   *  change (the value is the grant's gateway idempotency key). */
  benefitsReferenceId: string | null;
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
  /** Set when the change-set marked a benefit sync pending (markBenefitsPending
   *  option, applied non-empty): the grant's gateway idempotency key, committed
   *  ATOMICALLY with the seat rows so a crash can never lose the intent. */
  benefitsReferenceId: string | null;
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
      benefitsReferenceId: row.benefits_reference_id,
    };
  }

  /**
   * Paid seats of CURRENT members only — joined against `member` so a stale
   * row (member removed but the release hook never ran: crash mid-request)
   * can never count toward billing or the gateway allowance. Orphan rows are
   * harmless dust, cleared by the afterAddMember hook if the user ever
   * rejoins (invites always land free).
   */
  async listPaidSeatUserIds(organizationId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("organization_paid_seat")
      .innerJoin("member", (join) =>
        join
          .onRef("member.userId", "=", "organization_paid_seat.user_id")
          .onRef(
            "member.organizationId",
            "=",
            "organization_paid_seat.organization_id",
          ),
      )
      .select(["organization_paid_seat.user_id"])
      .where("organization_paid_seat.organization_id", "=", organizationId)
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
    opts?: { markBenefitsPending?: boolean },
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

      // Same member JOIN as listPaidSeatUserIds: never count a stale row.
      const paidSeats = await trx
        .selectFrom("organization_paid_seat")
        .innerJoin("member", (join) =>
          join
            .onRef("member.userId", "=", "organization_paid_seat.user_id")
            .onRef(
              "member.organizationId",
              "=",
              "organization_paid_seat.organization_id",
            ),
        )
        .select((eb) => eb.fn.countAll().as("count"))
        .where("organization_paid_seat.organization_id", "=", organizationId)
        .executeTakeFirst();

      // Benefit-sync intent commits WITH the seat rows — the crash-proof half
      // of the durable grant (the workflow + sweep are the delivery half).
      // Overwriting a previous pending ref is correct: grants are absolute
      // (full current amount), so only the LATEST change-set needs delivering.
      const benefitsReferenceId =
        opts?.markBenefitsPending && applied.length > 0
          ? crypto.randomUUID()
          : null;
      if (benefitsReferenceId) {
        await trx
          .updateTable("organization_billing")
          .set({
            benefits_reference_id: benefitsReferenceId,
            updated_at: new Date(),
          })
          .where("organization_id", "=", organizationId)
          .execute();
      }

      return {
        applied,
        paidSeatCount: Number(paidSeats?.count ?? 0),
        benefitsReferenceId,
      };
    });
  }

  /**
   * Drop a user's paid-seat row (if any) and log the transition. Called from
   * BOTH membership boundaries (auth/index.ts organizationHooks):
   *   - afterRemoveMember — a removed member must stop counting;
   *   - afterAddMember — invites always land FREE, so a stale row from a
   *     crashed removal can't resurrect as paid when the user rejoins.
   * Direct ops (not setSeats): at removal time the member row is already
   * gone, so setSeats' membership validation would reject it. Idempotent.
   */
  async releaseSeat(
    organizationId: string,
    userId: string,
    changedBy: string,
    opts?: { markBenefitsPending?: boolean },
  ): Promise<{ released: boolean; benefitsReferenceId: string | null }> {
    return await this.db.transaction().execute(async (trx) => {
      const deleted = await trx
        .deleteFrom("organization_paid_seat")
        .where("organization_id", "=", organizationId)
        .where("user_id", "=", userId)
        .returning("user_id")
        .executeTakeFirst();
      if (!deleted) return { released: false, benefitsReferenceId: null };
      await trx
        .insertInto("seat_change_log")
        .values({
          organization_id: organizationId,
          user_id: userId,
          seat: "free",
          changed_by: changedBy,
        })
        .execute();
      const benefitsReferenceId = opts?.markBenefitsPending
        ? crypto.randomUUID()
        : null;
      if (benefitsReferenceId) {
        await trx
          .updateTable("organization_billing")
          .set({
            benefits_reference_id: benefitsReferenceId,
            updated_at: new Date(),
          })
          .where("organization_id", "=", organizationId)
          .execute();
      }
      return { released: true, benefitsReferenceId };
    });
  }

  /**
   * Confirm a delivered grant: clear the pending marker iff it still holds
   * THIS reference (CAS) — a newer seat change may have replaced it, and that
   * newer grant must stay pending until its own delivery confirms.
   */
  async clearBenefitsPending(
    organizationId: string,
    referenceId: string,
  ): Promise<void> {
    await this.db
      .updateTable("organization_billing")
      .set({ benefits_reference_id: null, updated_at: new Date() })
      .where("organization_id", "=", organizationId)
      .where("benefits_reference_id", "=", referenceId)
      .execute();
  }

  /**
   * Orgs whose latest grant is still undelivered and stale enough that the
   * fast path clearly failed (pod died before enqueue, workflow exhausted) —
   * the sweep's work list.
   */
  async listBenefitsPending(
    olderThan: Date,
    limit: number,
  ): Promise<Array<{ organizationId: string; referenceId: string }>> {
    const rows = await this.db
      .selectFrom("organization_billing")
      .select(["organization_id", "benefits_reference_id"])
      .where("benefits_reference_id", "is not", null)
      .where("updated_at", "<", olderThan)
      .limit(limit)
      .execute();
    return rows.flatMap((r) =>
      r.benefits_reference_id
        ? [
            {
              organizationId: r.organization_id,
              referenceId: r.benefits_reference_id,
            },
          ]
        : [],
    );
  }
}
