import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "@/core/studio-context";
import { readSubscriptionUsage, unavailableUsage } from "./client";
import { SubscriptionProviderSchema, SubscriptionUsageSchema } from "./schema";

export const SUBSCRIPTION_USAGE_GET = defineTool({
  name: "SUBSCRIPTION_USAGE_GET",
  description:
    "Read the caller's linked Codex or Claude subscription usage windows and reset times. Never reads another member's plan or returns credentials.",
  annotations: {
    title: "Read personal subscription usage",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({ provider: SubscriptionProviderSchema }),
  outputSchema: SubscriptionUsageSchema,
  handler: async ({ provider }, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();
    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");
    const storage =
      provider === "codex"
        ? ctx.storage.codexSubscriptions
        : ctx.storage.claudeSubscriptions;
    try {
      const linked = await storage.find(userId);
      if (!linked)
        return {
          status: "disconnected" as const,
          reason: null,
          checkedAt: null,
          retryAt: null,
          limitReached: null,
          windows: [],
        };
      const credential = await storage.findLiveToken(userId);
      if (!credential) return unavailableUsage("authorization");
      return readSubscriptionUsage(
        provider,
        ctx.organization!.id,
        userId,
        credential,
      );
    } catch {
      return unavailableUsage("provider_error");
    }
  },
});
