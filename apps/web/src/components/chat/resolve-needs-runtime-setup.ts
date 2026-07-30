import type {
  AgentOption,
  AgentOptionAvailability,
} from "./pills/agent-options";

/**
 * Pure core of `useNeedsRuntimeSetup` — see that hook for the semantics.
 * Extracted so the gate can be unit-tested without mounting the chat context.
 *
 * `pendingAgentOption` is the *effective* option the chat context exposes:
 * on native it has already been filtered through `resolveNativeAgentOption`,
 * so `null` there means local CLI detection is cold or found nothing.
 */
export function resolveNeedsRuntimeSetup({
  isThreadLocked,
  isDesktopApp,
  hasCloudProviderKeys,
  pendingAgentOption,
  availability,
}: {
  isThreadLocked: boolean;
  isDesktopApp: boolean;
  hasCloudProviderKeys: boolean;
  pendingAgentOption: AgentOption | null;
  availability: AgentOptionAvailability;
}): boolean {
  // A locked thread has already run — it has history and a runtime pinned for
  // life. It must never be replaced by the setup empty state (which would hide
  // the conversation) or gate its tabs, even if a linked desktop later drops
  // offline in a keyless org. Setup only gates fresh, un-run threads.
  if (isThreadLocked) return false;

  // Native has no cloud runtime, so provider keys can't run a chat there. The
  // chat is startable only once the native resolver produced a local option —
  // either a detected CLI or an explicit prior pick. Until then the composer
  // would render with an empty model selector and no way out.
  if (isDesktopApp) return pendingAgentOption === null;

  const localRuntimeReady =
    (pendingAgentOption === "claude-code-desktop" && availability.claudeCode) ||
    (pendingAgentOption === "codex-desktop" && availability.codex);

  return !hasCloudProviderKeys && !localRuntimeReady;
}
