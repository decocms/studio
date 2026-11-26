import { selectsCodexForChats } from "@decocms/shared/harness/codex-models";
import { useQuery } from "@tanstack/react-query";
import { useHostedAiProviderKeys } from "@/hooks/collections/use-ai-providers";
import {
  useOrgFlag,
  useSandboxOnlyChats,
} from "@/hooks/use-organization-settings";
import { authClient } from "@/lib/auth-client";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useProjectContext } from "@/sdk";

/** The harness the server pins on the user's next new chat (`sandboxChatHarness`). */
export function useNewChatHarness(): "decopilot" | "claude-code" | "codex" {
  const sandboxOnlyChats = useSandboxOnlyChats();
  const codexChats = useOrgFlag("chat_harness_codex");
  const allKeys = useHostedAiProviderKeys();
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const userId = session?.user.id ?? "";
  const studio = useStudioTools();
  const hasCodexKey = allKeys.some((key) =>
    selectsCodexForChats(key.providerId),
  );
  const subscription = useQuery({
    queryKey: KEYS.codexSubscription(org.id, userId),
    queryFn: () => studio.call("CODEX_SUBSCRIPTION_STATUS", {}),
    enabled: sandboxOnlyChats && codexChats && !hasCodexKey,
  });
  if (!sandboxOnlyChats) return "decopilot";
  if (codexChats && (hasCodexKey || subscription.data?.connected === true)) {
    return "codex";
  }
  return "claude-code";
}
