import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { track } from "@/lib/posthog-client";
import { useStudioTools } from "@/lib/studio-tools";

export function useDecoConnect() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      await studio.call("AI_PROVIDER_PROVISION_KEY", { providerId: "deco" });
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
