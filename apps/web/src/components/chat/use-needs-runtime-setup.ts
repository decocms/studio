import { useQuery } from "@tanstack/react-query";
import { supportsClaudeCode } from "@decocms/shared/sdk/types/ai-providers";
import { useHostedAiProviderKeys } from "@/hooks/collections/use-ai-providers";
import { useOrgFlag } from "@/hooks/use-organization-settings";
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
 * linked Claude subscription. Native coding agents use the terminal runtime
 * adapter and never reach this structured-chat gate.
 */
export function useNeedsRuntimeSetup(): RuntimeSetupNeed {
  const allKeys = useHostedAiProviderKeys();
  const task = useOptionalChatTask();
  const sandboxOnlyChats = useOrgFlag("chat_harness_sandbox_only");
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const hasClaudeCodeKey = allKeys.some((key) =>
    supportsClaudeCode(key.providerId),
  );
  const subscription = useQuery({
    queryKey: KEYS.claudeSubscription(org.id),
    queryFn: () => studio.call("CLAUDE_SUBSCRIPTION_STATUS", {}),
    enabled: sandboxOnlyChats && !hasClaudeCodeKey,
  });

  return resolveNeedsRuntimeSetup({
    isThreadLocked: task?.isThreadLocked ?? false,
    hasCloudProviderKeys: allKeys.length > 0,
    sandboxOnlyChats,
    // Unknown until the status loads: let the server's guard answer instead.
    canRunClaudeCode:
      hasClaudeCodeKey || subscription.data?.connected !== false,
  });
}
