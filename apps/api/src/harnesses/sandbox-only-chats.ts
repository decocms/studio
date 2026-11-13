import { supportsCodex } from "@decocms/shared/harness/codex-models";
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
  getThreadRepository,
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
  harnessId: string = "claude-code",
): Promise<string | null> {
  return (
    (await resolvePlanCredential(ctx, organizationId, userId, harnessId))
      ?.providerId ?? null
  );
}

/**
 * Start (or resume) a chat's sandbox: ahead of its first message, so that
 * message dispatches onto a running sandbox, or for a CLI that wants to reach
 * it. Resolves the agent and branch the way dispatch does: any other handle
 * would be a second, unused VM. Returns the sandbox-proxy path parts.
 *
 * Never deleted here: the handle is shared with the agent's other chats on
 * the branch and with the site editor, so an unsent chat says nothing about
 * whether it is in use. An unused one idles out through the provider.
 */
export async function startThreadSandbox(
  ctx: StudioContext,
  thread: { id: string; virtual_mcp_id: string; branch: string | null },
  { wait = true }: { wait?: boolean } = {},
): Promise<{
  virtualMcpId: string;
  branch: string;
  /** Null when not waiting: the boot is still running. */
  sandboxHandle: string | null;
  previewUrl: string | null;
} | null> {
  const organizationId = ctx.organization?.id;
  if (!organizationId) return null;
  const virtualMcp = await ctx.storage.virtualMcps.findById(
    thread.virtual_mcp_id,
  );
  if (!virtualMcp) return null;
  const agent = resolveEffectiveStudioPackVirtualMcp(virtualMcp);
  const agentRepo = (
    agent.metadata as { repository?: RepositoryBinding | null } | null
  )?.repository;
  const branch = await resolveSandboxBranchForThread(ctx, {
    threadId: thread.id,
    agentRepo,
    runBranch: thread.branch ?? threadBranch(thread.id),
  });
  // After the branch: reading the thread's repo can repoint and persist it.
  // Dispatch's order: a repo bound to the chat wins over the agent's.
  const repository = (await getThreadRepository(ctx, thread.id)) ?? agentRepo;
  const boot = async () => {
    const { sandboxHandle, previewUrl } = await ensureSandbox(
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
        body: JSON.stringify({
          harness: await sandboxChatHarness(ctx, organizationId),
          threadId: thread.id,
        }),
      })
      .then((res) => {
        if (!res.ok)
          console.warn("[sandbox-prewarm] prepare refused", res.status);
      })
      .catch((err) => console.warn("[sandbox-prewarm] prepare failed", err));
    return { sandboxHandle, previewUrl: previewUrl ?? null };
  };
  if (!wait) {
    void boot().catch((err) =>
      console.warn("[sandbox-prewarm] background start failed", err),
    );
    return {
      virtualMcpId: agent.id,
      branch,
      sandboxHandle: null,
      previewUrl: null,
    };
  }
  return { virtualMcpId: agent.id, branch, ...(await boot()) };
}

/** The default for new sandbox chats; existing thread pins remain authoritative. */
export async function sandboxChatHarness(
  ctx: StudioContext,
  organizationId: string,
): Promise<"claude-code" | "codex"> {
  const settings = await ctx.storage.organizationSettings.get(organizationId);
  return orgFlagEnabled(settings?.flags, "chat_harness_codex")
    ? "codex"
    : "claude-code";
}

export async function hasCodexCredential(
  ctx: StudioContext,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  if (await userPlanCredentialId(ctx, organizationId, userId, "codex"))
    return true;
  const keys = await ctx.storage.aiProviderKeys.list({ organizationId });
  return keys.some((key) => supportsCodex(key.providerId));
}
