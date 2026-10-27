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
 * A plan shared with the org (only Copilot can be shared today) outranks the
 * dispatcher's own: the org turned sharing on so its runs would use it.
 * ponytail: shares are tried oldest first; a pool would pick among them here.
 *
 * A token that is gone, expired, or fails to decrypt (a rotated key) is
 * skipped rather than failing the dispatch.
 */
export async function resolvePlanCredential(
  ctx: StudioContext,
  organizationId: string,
  userId: string,
  harnessId: string = "claude-code",
): Promise<{ providerId: string; apiKey: string } | null> {
  if (harnessId === "codex") {
    const apiKey = await ctx.storage.codexSubscriptions
      .findLiveToken(userId)
      .catch(() => null);
    return apiKey
      ? { providerId: CODEX_SUBSCRIPTION_PROVIDER_ID, apiKey }
      : null;
  }
  const shared = await ctx.storage.orgSharedPlans.list(organizationId);
  const candidates = [
    ...shared.map(({ providerId, userId }) => ({ providerId, userId })),
    ...PLAN_PROVIDERS.map((providerId) => ({ providerId, userId })),
  ];
  for (const candidate of candidates) {
    const apiKey = await planTokens(ctx, candidate.providerId)
      .findLiveToken(candidate.userId)
      .catch((err) => {
        console.warn(`[plan] ${candidate.providerId} lookup failed`, err);
        return null;
      });
    if (apiKey) return { providerId: candidate.providerId, apiKey };
  }
  return null;
}
