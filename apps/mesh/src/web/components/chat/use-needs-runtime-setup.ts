import { useAiProviderKeys } from "@/web/hooks/collections/use-ai-providers";
import { useChatPrefs, useOptionalChatTask } from "./context";
import { useAgentOptionAvailability } from "./use-agent-availability";

/**
 * True when the org has no way to run a chat yet: no cloud AI provider AND no
 * usable local runtime selected. A linked desktop with Claude Code or Codex is
 * a valid runtime, so once the user picks one (and it's actually available)
 * this flips to false.
 *
 * Two surfaces read this so they stay in lockstep:
 *  - the chat panel shows the provider-setup empty state, and
 *  - the main-panel view tabs (Overview / Settings / …) are disabled — you
 *    can't browse the app until a runtime exists.
 */
export function useNeedsRuntimeSetup(): boolean {
  const allKeys = useAiProviderKeys();
  const { pendingAgentOption } = useChatPrefs();
  const availability = useAgentOptionAvailability();
  const task = useOptionalChatTask();

  // A locked thread has already run — it has history and a runtime pinned for
  // life. It must never be replaced by the setup empty state (which would hide
  // the conversation) or gate its tabs, even if a linked desktop later drops
  // offline in a keyless org. Setup only gates fresh, un-run threads.
  if (task?.isThreadLocked) return false;

  const localRuntimeReady =
    (pendingAgentOption === "claude-code-desktop" && availability.claudeCode) ||
    (pendingAgentOption === "codex-desktop" && availability.codex);

  return allKeys.length === 0 && !localRuntimeReady;
}
