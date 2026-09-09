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
import { toClientEntitlements } from "./client-entitlements";

export const AI_PLAN_ENTITLEMENTS = defineTool({
  name: "AI_PLAN_ENTITLEMENTS",
  description:
    "Get the organization's plan, its feature flags and the AI usage bar (a percentage, never a dollar amount)",
  inputSchema: z.object({
    providerId: z.enum(HOSTED_PROVIDER_IDS),
  }),
  outputSchema: z.object({
    plan: z.object({ id: z.string(), name: z.string() }),
    features: z.record(z.string(), z.boolean()),
    // Null when the gateway could not read usage — the UI must show "unknown",
    // never an empty bar, or a provider blip reads as "you've used nothing".
    usage: z
      .object({
        percent: z.number(),
        state: z.enum(["ok", "warn", "exhausted"]),
      })
      .nullable(),
    // The wallet, in dollars — deliberately the ONE amount on this payload.
    // The bar stays a percent; this is money the org bought and can spend once
    // the bar is full. Null when the gateway could not read usage.
    credits: z.object({ remainingUsd: z.number() }).nullable(),
    tasks: z.object({
      allowed: z.boolean(),
      remaining: z.number().nullable(),
      denyReason: z.string().nullable(),
    }),
    periodStart: z.string(),
    periodEnd: z.string(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    const adapter = getProviders()[input.providerId];
    if (!adapter) throw new Error(`Unknown provider: ${input.providerId}`);
    if (!adapter.getEntitlements) {
      throw new Error(`Provider ${input.providerId} does not expose plans`);
    }

    const studioJwt = await mintGatewayJwt(userId);
    // Projected, not returned raw: the gateway answers mesh's server with the
    // org's pinned MODEL, and §6 withholds that name from the org itself. See
    // client-entitlements.ts.
    return toClientEntitlements(
      await adapter.getEntitlements(studioJwt, org.id),
    );
  },
});
