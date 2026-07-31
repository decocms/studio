import { useAiProviderKeys } from "@/hooks/collections/use-ai-providers";
import { useIsDesktopApp } from "@/hooks/use-is-desktop-app";
import { useChatPrefs, useOptionalChatTask } from "./context";
import { useAgentOptionAvailability } from "./use-agent-availability";
import { resolveNeedsRuntimeSetup } from "./resolve-needs-runtime-setup";

/**
 * True when there is no way to run a chat yet.
 *
 * Web: the org has no cloud AI provider AND no usable local runtime selected.
 * A linked desktop with Claude Code or Codex is a valid runtime, so once the
 * user picks one (and it's actually available) this flips to false.
 *
 * Native: cloud providers don't exist there, so this is simply "the local
 * resolver has no agent option yet" — CLI detection is still cold or found
 * neither Claude Code nor Codex, and the user hasn't picked one explicitly.
 *
 * Read only by the chat side panel, which shows the runtime-setup empty state
 * when true. The main-panel view tabs stay navigable regardless — browsing the
 * app (Overview / Content / Settings / …) is never gated on runtime setup.
 */
export function useNeedsRuntimeSetup(): boolean {
  const allKeys = useAiProviderKeys();
  const { pendingAgentOption } = useChatPrefs();
  const availability = useAgentOptionAvailability();
  const task = useOptionalChatTask();
  const isDesktopApp = useIsDesktopApp();

  return resolveNeedsRuntimeSetup({
    isThreadLocked: task?.isThreadLocked ?? false,
    isDesktopApp,
    hasCloudProviderKeys: allKeys.length > 0,
    pendingAgentOption,
    availability,
  });
}
