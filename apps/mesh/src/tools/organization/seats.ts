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
import {
  benefitsSyncEnabled,
  enqueueBenefitsSync,
} from "../../billing/sync-org-benefits";
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
    /** Whether a durable benefit-sync delivery was queued. false = this
     *  deployment doesn't deliver benefits (no gateway admin) or nothing
     *  changed. Delivery itself is guaranteed by the pending marker committed
     *  with the seats + the DBOS workflow/sweep — not by this flag. */
    benefitsSyncQueued: z.boolean(),
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
      // The benefit-sync intent (pending marker) commits IN the same
      // transaction as the seat rows — a crash after this line can never
      // lose the gateway grant; the DBOS workflow + scheduled sweep deliver.
      result = await ctx.storage.organizationBilling.setSeats(
        organizationId,
        input.seats,
        changedBy,
        { markBenefitsPending: benefitsSyncEnabled() },
      );
    } catch (err) {
      if (err instanceof SeatTargetNotMemberError) {
        throw new Error(err.message);
      }
      throw err;
    }

    // Fast-path enqueue. Fail-soft: the marker is committed, so a failed
    // enqueue is exactly what the sweep exists for.
    let benefitsSyncQueued = false;
    if (result.benefitsReferenceId) {
      try {
        await enqueueBenefitsSync(
          organizationId,
          result.benefitsReferenceId,
          "apply",
        );
        benefitsSyncQueued = true;
      } catch (err) {
        console.error("Failed to enqueue benefit sync (sweep covers):", err);
      }
    }

    return {
      applied: result.applied,
      paidSeatCount: result.paidSeatCount,
      benefitsSyncQueued,
    };
  },
});
