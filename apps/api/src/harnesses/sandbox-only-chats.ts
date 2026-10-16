/**
 * The `chat_harness_sandbox_only` rollout: every chat runs claude-code in its
 * own sandbox instead of hosted Decopilot. See
 * `apps/api/src/harnesses/sandbox-harness-spec.md` (Rollout).
 */

import type { StudioContext } from "@/core/studio-context";
import { resolvePlanCredential } from "@/harnesses/plan-credential";
import { agentSandboxEnabled } from "@/settings";
import { getAgentSandboxProvider } from "@/sandbox/lifecycle";
import { ensureSandbox } from "@/tools/sandbox/start";
import {
  resolveSandboxBranchForThread,
  threadBranch,
} from "@/tools/sandbox/thread-repo";
import { resolveEffectiveStudioPackVirtualMcp } from "@/tools/virtual/studio-pack";
import type { RepositoryBinding } from "@decocms/shared/sdk";
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
      "Chats need an Anthropic, OpenRouter or deco AI Gateway provider, or your own linked Claude or GitHub Copilot plan. Connect one in Settings → AI Providers.",
    );
    this.name = "ClaudeCodeProviderRequiredError";
  }
}

/**
 * Whether a claude-code run has any credential to start on: an org key of a
 * provider it supports, or a Claude or Copilot plan — shared with the org or
 * the user's own — which outranks the org key at dispatch.
 */
export async function hasClaudeCodeCredential(
  ctx: StudioContext,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const keys = await ctx.storage.aiProviderKeys.list({ organizationId });
  if (keys.some((key) => supportsClaudeCode(key.providerId))) return true;
  return (await userPlanCredentialId(ctx, organizationId, userId)) !== null;
}

/** The plan a run would bill, in dispatch's order, or null. */
export async function userPlanCredentialId(
  ctx: StudioContext,
  organizationId: string,
  userId: string,
): Promise<string | null> {
  return (
    (await resolvePlanCredential(ctx, organizationId, userId))?.providerId ??
    null
  );
}

/**
 * Start a new chat's sandbox while its first message is being typed, so that
 * message dispatches onto a running sandbox. Resolves the agent and branch the
 * way dispatch does: any other handle would be a second, unused VM.
 *
 * Never deleted here: the handle is shared with the agent's other chats on
 * the branch and with the site editor, so an unsent chat says nothing about
 * whether it is in use. An unused one idles out through the provider.
 */
export async function prewarmThreadSandbox(
  ctx: StudioContext,
  thread: { id: string; virtual_mcp_id: string; branch: string | null },
): Promise<void> {
  const virtualMcp = await ctx.storage.virtualMcps.findById(
    thread.virtual_mcp_id,
  );
  if (!virtualMcp) return;
  const agent = resolveEffectiveStudioPackVirtualMcp(virtualMcp);
  const repository = (
    agent.metadata as { repository?: RepositoryBinding | null } | null
  )?.repository;
  const branch = await resolveSandboxBranchForThread(ctx, {
    threadId: thread.id,
    agentRepo: repository,
    runBranch: thread.branch ?? threadBranch(thread.id),
  });
  const { sandboxHandle } = await ensureSandbox(
    {
      virtualMcpId: agent.id,
      branch,
      purpose: repository?.url ? "interactive" : "harness-run",
    },
    ctx,
  );
  // The thread's org-fs prep, so the first run's daemon finds it done.
  const provider = await getAgentSandboxProvider(ctx);
  await provider
    .proxyDaemonRequest(sandboxHandle, "/_sandbox/prepare", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify({ harness: "claude-code", threadId: thread.id }),
    })
    .then((res) => {
      if (!res.ok)
        console.warn("[sandbox-prewarm] prepare refused", res.status);
    })
    .catch((err) => console.warn("[sandbox-prewarm] prepare failed", err));
}
