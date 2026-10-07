import z from "zod";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";
import { HOSTED_PROVIDER_IDS } from "../../ai-providers/provider-ids";
import { getProviders } from "../../ai-providers/registry";
import { mintGatewayJwt } from "../../auth/jwt";
import { invalidateOrgFeaturesEverywhere } from "../../billing/plan-cache-broadcast";
import {
  gatewayAdminConfigured,
  setGatewayOrgPlan,
} from "../../billing/gateway-admin";
import { getSettings } from "../../settings";
import { captureOrgEvent } from "@/posthog";

const planSchema = z.object({
  id: z.string(),
  name: z.string(),
  features: z.record(z.string(), z.boolean()),
});

export const AI_PLAN_LIST = defineTool({
  name: "AI_PLAN_LIST",
  description: "List the plans an organization can move to",
  inputSchema: z.object({ providerId: z.enum(HOSTED_PROVIDER_IDS) }),
  outputSchema: z.object({ plans: z.array(planSchema) }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    const adapter = getProviders()[input.providerId];
    if (!adapter?.listPlans) {
      throw new Error(`Provider ${input.providerId} does not expose plans`);
    }
    const studioJwt = await mintGatewayJwt(userId);
    return { plans: await adapter.listPlans(studioJwt, org.id) };
  },
});

/**
 * Drops the org back to the free tier. It cannot grant a paid one.
 *
 * This took ANY plan id once, and took no payment for it — so an org admin
 * could open the plan picker, click Ultra, and receive every gated feature and
 * a $400 monthly AI allowance for nothing. The gateway route behind it says as
 * much in its own comment ("mesh owns the role check and the payment that must
 * precede this call"); mesh owned the role check and never the payment.
 *
 * A paid tier is now granted by exactly one thing: a Stripe subscription whose
 * price is in STRIPE_PLAN_PRICE_IDS, applied by the webhook. Upgrades go
 * through ORGANIZATION_BILLING_CHECKOUT_START, and an operator placing a plan
 * by hand goes through the gateway's admin API, which is admin-token gated.
 *
 * Downgrading is refused too while a subscription is bound: cancelling at the
 * gateway would strip the features while Stripe kept charging for them. That
 * cancellation belongs in Stripe's customer portal, and its
 * `subscription.deleted` comes back here as a plan change to free.
 */
export const AI_PLAN_SET = defineTool({
  name: "AI_PLAN_SET",
  description:
    "Drop the organization back to the free tier. Paid plans are granted by subscribing (ORGANIZATION_BILLING_CHECKOUT_START), never here.",
  inputSchema: z.object({
    providerId: z.enum(HOSTED_PROVIDER_IDS),
    planId: z.literal("free"),
  }),
  outputSchema: z.object({
    plan: z.object({ id: z.string(), name: z.string() }),
    features: z.record(z.string(), z.boolean()),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    // A live subscription is Stripe's to end. Dropping the plan here would
    // take the features away and leave the card being charged for them.
    const billing = await ctx.storage.organizationBilling.getBilling(org.id);
    if (billing?.stripeSubscriptionId) {
      throw new Error(
        "This organization has an active subscription — cancel it in billing first; the plan drops to free when it ends.",
      );
    }

    const adapter = getProviders()[input.providerId];
    if (!adapter?.setPlan) {
      throw new Error(`Provider ${input.providerId} does not expose plans`);
    }
    const studioJwt = await mintGatewayJwt(userId);
    const result = await adapter.setPlan(studioJwt, org.id, input.planId);
    // Drop the gate's cached features so the very next tool call sees the new
    // plan. Without this a plan change appears to do nothing for up to a minute.
    // Fleet-wide over NATS — a per-pod drop left the answer depending on which
    // replica the next request happened to reach.
    invalidateOrgFeaturesEverywhere(org.id);
    return { plan: result.plan, features: result.features };
  },
});

/**
 * Why an invoice upgrade must be refused, or null when it may go ahead.
 *
 * Every unknown refuses: this grants a paid plan with no payment, so it is the
 * opposite of the feature gate's fail-open bias. `entitlements` is null when
 * the gateway was not asked or did not answer.
 */
export function invoiceUpgradeRefusal(input: {
  plansEnabled: boolean;
  entitlements: {
    planId: string;
    features: Record<string, boolean>;
    /** Null when the gateway could not read usage — which refuses. */
    usageState: "ok" | "warn" | "exhausted" | null;
  } | null;
  subscriptionBound: boolean;
  targetPlanId: string;
}): string | null {
  if (!input.plansEnabled) return "Plans are not enabled on this deployment.";
  if (!input.entitlements) return "Could not read this organization's plan.";
  if (input.entitlements.features.invoice_upgrade !== true) {
    return "This organization cannot add a plan to its invoice.";
  }
  // The offer is for an org that has run out, not a standing self-serve
  // upgrade path around Stripe.
  if (input.entitlements.usageState !== "exhausted") {
    return "Invoice upgrades open once this organization's AI usage limit is reached.";
  }
  // A Stripe subscription owns this org's plan; a second, invoiced one would
  // be overwritten by the next webhook or billed twice.
  if (input.subscriptionBound) {
    return "This organization has an active subscription — change plans through billing.";
  }
  if (input.entitlements.planId === input.targetPlanId) {
    return "This organization is already on that plan.";
  }
  return null;
}

/**
 * Move a flagged org (`invoice_upgrade`) onto a paid plan now and bill it on
 * the org's next invoice, outside Stripe. deco finance learns of it from the
 * `plan_invoice_upgrade` event.
 *
 * Not `requiresFeature`: that gate fails OPEN when the gateway cannot answer,
 * which would hand out a paid plan. The flag is read fresh, past the gate's
 * cache, and anything short of a `true` refuses.
 */
export const AI_PLAN_INVOICE_UPGRADE = defineTool({
  name: "AI_PLAN_INVOICE_UPGRADE",
  description:
    "Move the organization to a paid plan now, billed on its next deco invoice. Only for organizations deco enabled for invoice billing.",
  inputSchema: z.object({ planId: z.enum(["starter", "business"]) }),
  outputSchema: z.object({ planId: z.string() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    const plansEnabled = getSettings().plansEnabled && gatewayAdminConfigured();
    const billing = await ctx.storage.organizationBilling.getBilling(org.id);
    const adapter = getProviders().deco;
    let entitlements: {
      planId: string;
      features: Record<string, boolean>;
      usageState: "ok" | "warn" | "exhausted" | null;
    } | null = null;
    if (plansEnabled && adapter?.getEntitlements) {
      const read = await adapter.getEntitlements(
        await mintGatewayJwt(userId),
        org.id,
      );
      if (read.features && typeof read.features === "object") {
        entitlements = {
          planId: read.plan.id,
          features: read.features,
          usageState: read.usage?.state ?? null,
        };
      }
    }
    const refusal = invoiceUpgradeRefusal({
      plansEnabled,
      entitlements,
      subscriptionBound: !!billing?.stripeSubscriptionId,
      targetPlanId: input.planId,
    });
    if (refusal || !entitlements) {
      throw new Error(refusal ?? "Could not read this organization's plan.");
    }

    const by = ctx.auth.user?.email ?? userId;
    await setGatewayOrgPlan({
      organizationId: org.id,
      planId: input.planId,
      note: `invoice upgrade by ${by} at ${new Date().toISOString()} — bill on next invoice`,
    });
    invalidateOrgFeaturesEverywhere(org.id);
    captureOrgEvent({
      event: "plan_invoice_upgrade",
      organizationId: org.id,
      userId,
      properties: {
        plan_id: input.planId,
        previous_plan_id: entitlements.planId,
        org_slug: org.slug,
        org_name: org.name,
      },
    });
    return { planId: input.planId };
  },
});
