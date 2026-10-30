import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useT } from "@/i18n/use-t.ts";

/** The member's own Claude subscription: its status, and linking it. */
export function useClaudeSubscription() {
  const t = useT();
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const userId = session?.user.id ?? "";
  const studio = useStudioTools();
  const queryClient = useQueryClient();

  const status = useQuery({
    queryKey: KEYS.claudeSubscription(org.id, userId),
    queryFn: () => studio.call("CLAUDE_SUBSCRIPTION_STATUS", {}),
    enabled: Boolean(userId),
  });

  const invalidate = async () => {
    await queryClient.cancelQueries({
      queryKey: KEYS.subscriptionUsage(org.id, userId, "claude"),
    });
    queryClient.removeQueries({
      queryKey: KEYS.subscriptionUsage(org.id, userId, "claude"),
    });
    await queryClient.invalidateQueries({
      queryKey: KEYS.claudeSubscription(org.id, userId),
    });
  };

  const connect = useMutation({
    mutationFn: (token: string) =>
      studio.call("CLAUDE_SUBSCRIPTION_CONNECT", { token }),
    onSuccess: async () => {
      await invalidate();
      toast.success(t("settings.claudeSubscription.connected"));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const disconnect = useMutation({
    mutationFn: () => studio.call("CLAUDE_SUBSCRIPTION_DISCONNECT", {}),
    onSuccess: async () => {
      await invalidate();
      toast.success(t("settings.claudeSubscription.disconnected"));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const connected = status.data?.connected === true;
  // A row that exists but is not `connected` is a token Anthropic has aged
  // out — the only state where "paste a new one" is the honest label.
  const expired = !connected && Boolean(status.data?.linkedAt);

  return {
    orgId: org.id,
    userId,
    status,
    connected,
    expired,
    linkedAt: status.data?.linkedAt ?? null,
    connect,
    disconnect,
  };
}
