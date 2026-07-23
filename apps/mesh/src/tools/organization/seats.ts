/**
 * ORGANIZATION_SEATS_GET / ORGANIZATION_SEATS_SET
 *
 * Per-seat billing management. Seats are monetization, orthogonal to Better
 * Auth roles: a paid seat unlocks mutations + AI spend when the deployment
 * enforces billing (STUDIO_BILLING_ENFORCED); a free seat is readonly. GET is
 * readOnlyHint so even free-seat members can render the members/billing page.
 *
 * SET currently applies only to `invoiced` (contract) orgs — their admins
 * toggle seats freely and the seat_change_log is the end-of-cycle invoicing
 * source. `self_serve` orgs get their SET path with the Stripe integration
 * (checkout/proration), and legacy orgs have no seats to manage.
 */

import { z } from "zod";
import { syncOrgBenefits } from "../../billing/sync-org-benefits";
import { defineTool } from "../../core/define-tool";
import { requireAuth, getUserId } from "../../core/studio-context";
import { SeatTargetNotMemberError } from "../../storage/organization-billing";

const BillingSchema = z.object({
  legacy: z.boolean(),
  billingMode: z.string(),
  status: z.string(),
  includedReportUrl: z.string().nullable(),
});

export const ORGANIZATION_SEATS_GET = defineTool({
  name: "ORGANIZATION_SEATS_GET",
  description:
    "Get the organization's billing identity and which members hold paid seats.",
  annotations: {
    title: "Get Organization Seats",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    /** null = org predates billing entirely (no row — treated as legacy). */
    billing: BillingSchema.nullable(),
    paidSeatUserIds: z.array(z.string()),
  }),

  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error("Organization context required");
    }

    const [billing, paidSeatUserIds] = await Promise.all([
      ctx.storage.organizationBilling.getBilling(organizationId),
      ctx.storage.organizationBilling.listPaidSeatUserIds(organizationId),
    ]);

    return {
      billing: billing
        ? {
            legacy: billing.legacy,
            billingMode: billing.billingMode,
            status: billing.status,
            includedReportUrl: billing.includedReportUrl,
          }
        : null,
      paidSeatUserIds,
    };
  },
});

export const ORGANIZATION_SEATS_SET = defineTool({
  name: "ORGANIZATION_SEATS_SET",
  description:
    "Set members' seats (paid/free). Currently available for invoiced (contract) organizations only; self-serve organizations change seats through checkout.",
  annotations: {
    title: "Set Organization Seats",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    seats: z
      .array(
        z.object({
          userId: z.string().min(1),
          seat: z.enum(["paid", "free"]),
        }),
      )
      .min(1)
      .max(200),
  }),
  outputSchema: z.object({
    /** Transitions actually applied — no-ops are skipped and not logged. */
    applied: z.array(
      z.object({ userId: z.string(), seat: z.enum(["paid", "free"]) }),
    ),
    paidSeatCount: z.number(),
    /** Whether the gateway allowance grant succeeded. false = seats saved
     *  but the benefit sync failed/was skipped — the NEXT apply re-grants
     *  the full current amount, so the state self-heals. */
    benefitsSynced: z.boolean(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error("Organization context required");
    }
    const changedBy = getUserId(ctx);
    if (!changedBy) {
      throw new Error("User ID required");
    }

    const billing =
      await ctx.storage.organizationBilling.getBilling(organizationId);
    if (!billing || billing.legacy) {
      throw new Error(
        "This organization is on the legacy plan — seats do not apply.",
      );
    }
    if (billing.billingMode !== "invoiced") {
      // TODO(billing/phase-3): self_serve seat changes go through Stripe
      // preview + prorated charge before they land here.
      throw new Error(
        "Self-serve seat changes require checkout, which is not available yet.",
      );
    }

    let result: Awaited<
      ReturnType<typeof ctx.storage.organizationBilling.setSeats>
    >;
    try {
      result = await ctx.storage.organizationBilling.setSeats(
        organizationId,
        input.seats,
        changedBy,
      );
    } catch (err) {
      if (err instanceof SeatTargetNotMemberError) {
        throw new Error(err.message);
      }
      throw err;
    }

    // Benefits ride the seat change but never fail it: the seats are already
    // committed (they're the billing truth), and a failed grant self-heals on
    // the next apply (every call re-grants the full current amount). One
    // referenceId per applied change-set keeps gateway retries deduped.
    let benefitsSynced = false;
    if (result.applied.length > 0) {
      try {
        const sync = await syncOrgBenefits({
          organizationId,
          paidSeatCount: result.paidSeatCount,
          referenceId: `seats:${organizationId}:${crypto.randomUUID()}`,
        });
        benefitsSynced = sync.allowanceSynced;
      } catch (err) {
        console.error("Failed to sync org benefits after seat change:", err);
      }
    }

    return { ...result, benefitsSynced };
  },
});
