import { authClient } from "@/lib/auth-client";
import { supportsCodex } from "@decocms/shared/harness/codex-models";
import { useQuery } from "@tanstack/react-query";
import { supportsClaudeCode } from "@decocms/shared/sdk/types/ai-providers";
import { useHostedAiProviderKeys } from "@/hooks/collections/use-ai-providers";
import {
  useOrgFlag,
  useSandboxOnlyChats,
} from "@/hooks/use-organization-settings";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useProjectContext } from "@/sdk";
import { useOptionalChatTask } from "./context";
import {
  resolveNeedsRuntimeSetup,
  type RuntimeSetupNeed,
} from "./resolve-needs-runtime-setup";

/**
 * The setup a chat needs before it can run, or null.
 *
 * Read only by the web chat side panel, which shows the provider setup empty
 * state for a fresh thread when the organization has no cloud provider key —
 * or, under `chat_harness_sandbox_only`, no key claude-code can run on and no
 * linked Claude or GitHub Copilot plan.
 */
export function useNeedsRuntimeSetup(): RuntimeSetupNeed {
  const allKeys = useHostedAiProviderKeys();
  const task = useOptionalChatTask();
  const sandboxOnlyChats = useSandboxOnlyChats();
  const codexChats = useOrgFlag("chat_harness_codex");
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
    enabled: sandboxOnlyChats && !codexChats && !hasClaudeCodeKey,
  });
  const copilot = useQuery({
    queryKey: KEYS.githubCopilot(org.id),
    queryFn: () => studio.call("GITHUB_COPILOT_STATUS", {}),
    enabled: sandboxOnlyChats && !codexChats && !hasClaudeCodeKey,
  });

  const codex = useQuery({
    queryKey: KEYS.codexSubscription(org.id, userId),
    queryFn: () => studio.call("CODEX_SUBSCRIPTION_STATUS", {}),
    enabled: sandboxOnlyChats && codexChats,
  });
  if (sandboxOnlyChats && codexChats && !task?.isThreadLocked) {
    const hasKey = allKeys.some((key) => supportsCodex(key.providerId));
    return hasKey || codex.data?.connected !== false ? null : "codex-provider";
  }
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
