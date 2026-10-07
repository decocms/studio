/**
 * Pure core of `useNeedsRuntimeSetup` — see that hook for the semantics.
 * Extracted so the gate can be unit-tested without mounting the chat context.
 */

/** Which setup a fresh thread needs before it can run, or null for none. */
export type RuntimeSetupNeed = "provider" | "claude-code-provider" | null;

export function resolveNeedsRuntimeSetup({
  isThreadLocked,
  hasCloudProviderKeys,
  sandboxOnlyChats,
  canRunClaudeCode,
}: {
  isThreadLocked: boolean;
  hasCloudProviderKeys: boolean;
  /** The org's `chat_harness_sandbox_only` flag. */
  sandboxOnlyChats: boolean;
  /** A claude-code-capable org key or the user's own Claude subscription. */
  canRunClaudeCode: boolean;
}): RuntimeSetupNeed {
  // A locked thread has already run — it has history and a runtime pinned for
  // life. It must never be replaced by the setup empty state, which would hide
  // the conversation. Setup only gates fresh, un-run threads.
  if (isThreadLocked) return null;

  if (!hasCloudProviderKeys && !(sandboxOnlyChats && canRunClaudeCode)) {
    return "provider";
  }
  if (sandboxOnlyChats && !canRunClaudeCode) return "claude-code-provider";
  return null;
}
