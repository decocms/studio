/**
 * The `chat_harness_sandbox_only` rollout: every chat runs claude-code in its
 * own sandbox instead of hosted Decopilot. See
 * `apps/api/src/harnesses/sandbox-harness-spec.md` (Rollout).
 */

import type { StudioContext } from "@/core/studio-context";
import { agentSandboxEnabled } from "@/settings";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import { supportsClaudeCode } from "@decocms/shared/sdk/types/ai-providers";

/**
 * Whether the org runs sandbox-only chats. Never throws: an unreadable settings
 * row reads as off, which is what every org had before the flag existed.
 */
export async function sandboxOnlyChatsEnabled(
  ctx: StudioContext,
  organizationId: string,
): Promise<boolean> {
  // Without a hosted sandbox, claude-code only fails later, at dispatch.
  if (!agentSandboxEnabled()) return false;
  try {
    const settings = await ctx.storage.organizationSettings.get(organizationId);
    return orgFlagEnabled(settings?.flags, "chat_harness_sandbox_only");
  } catch (err) {
    console.warn("[sandbox-only-chats] flag read failed", err);
    return false;
  }
}

export class ClaudeCodeProviderRequiredError extends Error {
  readonly code = "claude_code_provider_required";
  constructor() {
    super(
      "Chats need an Anthropic, OpenRouter or deco AI Gateway provider, or your own linked Claude subscription. Connect one in Settings → AI Providers.",
    );
    this.name = "ClaudeCodeProviderRequiredError";
  }
}

/**
 * Whether a claude-code run has any credential to start on: an org key of a
 * provider it supports, or the user's own unexpired Claude subscription (which
 * outranks the org key at dispatch).
 */
export async function hasClaudeCodeCredential(
  ctx: StudioContext,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const keys = await ctx.storage.aiProviderKeys.list({ organizationId });
  if (keys.some((key) => supportsClaudeCode(key.providerId))) return true;
  const subscription = await ctx.storage.claudeSubscriptions.find(userId);
  return (
    subscription !== null &&
    (subscription.expiresAt === null ||
      new Date(subscription.expiresAt).getTime() > Date.now())
  );
}
