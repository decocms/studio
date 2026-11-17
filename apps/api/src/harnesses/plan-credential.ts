import { CODEX_SUBSCRIPTION_PROVIDER_ID } from "@decocms/shared/harness/codex-models";
import type { StudioContext } from "@/core/studio-context";
import {
  CLAUDE_SUBSCRIPTION_PROVIDER_ID,
  GITHUB_COPILOT_PROVIDER_ID,
} from "./claude-code-env";

/** A user's own plans: Claude before Copilot. */
const PLAN_PROVIDERS = [
  CLAUDE_SUBSCRIPTION_PROVIDER_ID,
  GITHUB_COPILOT_PROVIDER_ID,
] as const;

const planTokens = (ctx: StudioContext, providerId: string) =>
  providerId === CLAUDE_SUBSCRIPTION_PROVIDER_ID
    ? ctx.storage.claudeSubscriptions
    : ctx.storage.githubCopilotSubscriptions;

/**
 * The plan a sandbox run bills, or null for the org's model key.
 *
 * The dispatcher's own plans come first, so a member who linked a plan bills
 * their own seat. A plan another member shared with the org (only Copilot can
 * be shared today) covers members who linked none, oldest share first. Every
 * shareable provider follows the same order.
 *
 * A token that is gone, expired, or fails to decrypt (a rotated key) is
 * skipped rather than failing the dispatch.
 */
export interface PlanCredential {
  providerId: string;
  apiKey: string;
  /** Set when the plan is another member's, shared with the org. */
  sharedBy?: { userId: string; userName: string | null };
}

export async function resolvePlanCredential(
  ctx: StudioContext,
  organizationId: string,
  userId: string,
  harnessId: string = "claude-code",
): Promise<PlanCredential | null> {
  if (harnessId === "codex") {
    const apiKey = await ctx.storage.codexSubscriptions
      .findLiveToken(userId)
      .catch(() => null);
    return apiKey
      ? { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, apiKey }
      : null;
  }
  const shared = await ctx.storage.orgSharedPlans.list(organizationId);
  const candidates: Array<{
    providerId: string;
    userId: string;
    sharedBy?: PlanCredential["sharedBy"];
  }> = [
    ...PLAN_PROVIDERS.map((providerId) => ({ providerId, userId })),
    ...shared
      .filter((plan) => plan.userId !== userId)
      .map((plan) => ({
        providerId: plan.providerId,
        userId: plan.userId,
        sharedBy: { userId: plan.userId, userName: plan.userName ?? null },
      })),
  ];
  for (const candidate of candidates) {
    const apiKey = await planTokens(ctx, candidate.providerId)
      .findLiveToken(candidate.userId)
      .catch((err) => {
        console.warn(`[plan] ${candidate.providerId} lookup failed`, err);
        return null;
      });
    if (apiKey) {
      const { providerId, sharedBy } = candidate;
      return sharedBy
        ? { providerId, apiKey, sharedBy }
        : { providerId, apiKey };
    }
  }
  return null;
}
