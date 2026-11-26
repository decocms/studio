import { authClient } from "@/lib/auth-client";
import { useQuery } from "@tanstack/react-query";
import { supportsClaudeCode } from "@decocms/shared/sdk/types/ai-providers";
import { useHostedAiProviderKeys } from "@/hooks/collections/use-ai-providers";
import { useSandboxOnlyChats } from "@/hooks/use-organization-settings";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useProjectContext } from "@/sdk";
import { useOptionalChatTask } from "./context";
import { useNewChatHarness } from "./use-new-chat-harness";
import {
  resolveNeedsRuntimeSetup,
  type RuntimeSetupNeed,
} from "./resolve-needs-runtime-setup";

/**
 * The setup a chat needs before it can run, or null.
 *
 * Read only by the web chat side panel, which shows the provider setup empty
 * state for a fresh thread when the organization has no cloud provider key —
 * or, when chats run in sandboxes, no key claude-code can run on and no
 * linked Claude or GitHub Copilot plan.
 */
export function useNeedsRuntimeSetup(): RuntimeSetupNeed {
  const allKeys = useHostedAiProviderKeys();
  const task = useOptionalChatTask();
  const sandboxOnlyChats = useSandboxOnlyChats();
  // A new chat goes to Codex only on a Codex credential, so it needs no setup.
  const codexChat = useNewChatHarness() === "codex";
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const userId = session?.user.id ?? "";
  const studio = useStudioTools();
  const hasClaudeCodeKey = allKeys.some((key) =>
    supportsClaudeCode(key.providerId),
  );
  const subscription = useQuery({
    queryKey: KEYS.claudeSubscription(org.id, userId),
    queryFn: () => studio.call("CLAUDE_SUBSCRIPTION_STATUS", {}),
    enabled: sandboxOnlyChats && !codexChat && !hasClaudeCodeKey,
  });
  const copilot = useQuery({
    queryKey: KEYS.githubCopilot(org.id),
    queryFn: () => studio.call("GITHUB_COPILOT_STATUS", {}),
    enabled: sandboxOnlyChats && !codexChat && !hasClaudeCodeKey,
  });
  if (codexChat && !task?.isThreadLocked) return null;
  return resolveNeedsRuntimeSetup({
    isThreadLocked: task?.isThreadLocked ?? false,
    hasCloudProviderKeys: allKeys.length > 0,
    sandboxOnlyChats,
    // Unknown until the status loads: let the server's guard answer instead.
    canRunClaudeCode:
      hasClaudeCodeKey ||
      subscription.data?.connected !== false ||
      copilot.data?.connected !== false ||
      Boolean(copilot.data?.orgShare),
  });
}
