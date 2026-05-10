import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import { track } from "@/web/lib/posthog-client";

export function useDecoConnect() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const result = (await client.callTool({
        name: "AI_PROVIDER_PROVISION_KEY",
        arguments: { providerId: "deco" },
      })) as { isError?: boolean; content?: { text?: string }[] };
      if (result?.isError) {
        throw new Error(result.content?.[0]?.text ?? "Key provisioning failed");
      }
    },
    onSuccess: () => {
      track("ai_provider_provision_succeeded", { provider_id: "deco" });
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviderKeys(org.id) });
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviders(org.id) });
      toast.success("Deco AI Gateway connected successfully");
    },
    onError: (err) => {
      track("ai_provider_provision_failed", {
        provider_id: "deco",
        error: err.message,
      });
      toast.error(`Failed to connect Deco AI Gateway: ${err.message}`);
    },
  });
}
