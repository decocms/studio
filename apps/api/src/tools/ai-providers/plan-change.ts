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
import { invalidateOrgFeaturesCache } from "../../core/plan-feature-gate";

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
 * Moves the org onto a plan. NOTE: no payment is taken and no contract is
 * signed here — this is the mechanical half of a plan change, exposed so the
 * tier can be switched while the billing flow around it is still being built.
 */
export const AI_PLAN_SET = defineTool({
  name: "AI_PLAN_SET",
  description:
    "Change the organization's plan ('free' drops back to the free tier). Does not take payment.",
  inputSchema: z.object({
    providerId: z.enum(HOSTED_PROVIDER_IDS),
    planId: z.string(),
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

    const adapter = getProviders()[input.providerId];
    if (!adapter?.setPlan) {
      throw new Error(`Provider ${input.providerId} does not expose plans`);
    }
    const studioJwt = await mintGatewayJwt(userId);
    const result = await adapter.setPlan(studioJwt, org.id, input.planId);
    // Drop the gate's cached features so the very next tool call sees the new
    // plan. Without this an upgrade appears to do nothing for up to a minute —
    // the user switches to Ultra and the feature they just bought is still
    // refused. Only this instance; other pods still wait out their TTL.
    invalidateOrgFeaturesCache(org.id);
    return { plan: result.plan, features: result.features };
  },
});
