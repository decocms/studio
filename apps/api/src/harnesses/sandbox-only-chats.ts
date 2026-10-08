/**
 * The `chat_harness_sandbox_only` rollout: every chat runs claude-code in its
 * own sandbox instead of hosted Decopilot. See
 * `apps/api/src/harnesses/sandbox-harness-spec.md` (Rollout).
 */

import type { StudioContext } from "@/core/studio-context";
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

/**
 * How long a prewarmed sandbox waits for its chat's first message before it is
 * deleted. ponytail: in-process timer; a Studio restart inside this window
 * leaves the VM to the provider's own idle pause and auto-delete.
 */
const PREWARM_UNUSED_MS = 3 * 60_000;

/**
 * Start a new chat's sandbox while its first message is being typed, so that
 * message dispatches onto a running sandbox. Resolves the agent and branch the
 * way dispatch does: any other handle would be a second, unused VM. Deleted
 * if the chat never sends; a first message pins `harness_id`, from any pod.
 */
export async function prewarmThreadSandbox(
  ctx: StudioContext,
  organizationId: string,
  thread: { id: string; virtual_mcp_id: string; branch: string | null },
): Promise<void> {
  const virtualMcp = await ctx.storage.virtualMcps.findById(
    thread.virtual_mcp_id,
  );
  if (!virtualMcp) return;
  const agent = await resolveEffectiveStudioPackVirtualMcp({
    virtualMcp,
    organizationId,
    ctx,
  });
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
  setTimeout(async () => {
    try {
      const current = await ctx.storage.threads.get(thread.id);
      if (current?.harness_id) return;
      await provider.delete(sandboxHandle);
      console.log("[sandbox-prewarm] deleted unused sandbox", {
        threadId: thread.id,
        handle: sandboxHandle,
      });
    } catch (err) {
      console.warn("[sandbox-prewarm] unused sandbox cleanup failed", err);
    }
  }, PREWARM_UNUSED_MS).unref?.();
}
