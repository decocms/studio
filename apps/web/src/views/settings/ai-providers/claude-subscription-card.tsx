/**
 * Link your own Claude subscription, so sandbox-hosted claude-code runs bill
 * against your plan instead of the org's AI credit.
 *
 * The token is minted by Anthropic's own client (`claude setup-token`) and
 * pasted here — so the user picks which account pays, in Anthropic's UI, and
 * Studio never has to guess.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useT } from "@/i18n/use-t.ts";

export function ClaudeSubscriptionCard() {
  const t = useT();
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");

  const status = useQuery({
    queryKey: KEYS.claudeSubscription(org.id),
    queryFn: () => studio.call("CLAUDE_SUBSCRIPTION_STATUS", {}),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: KEYS.claudeSubscription(org.id),
    });

  const connect = useMutation({
    mutationFn: () => studio.call("CLAUDE_SUBSCRIPTION_CONNECT", { token }),
    onSuccess: async () => {
      setToken("");
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

  return (
    <div className="rounded-xl border border-border px-6 py-5 flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-base font-semibold">
            {t("settings.claudeSubscription.title")}
          </p>
          <p className="text-sm text-muted-foreground">
            {connected
              ? t("settings.claudeSubscription.active")
              : expired
                ? t("settings.claudeSubscription.expired")
                : t("settings.claudeSubscription.description")}
          </p>
        </div>
        {connected ? (
          <Button
            variant="outline"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate()}
          >
            {t("settings.claudeSubscription.disconnect")}
          </Button>
        ) : null}
      </div>
      {connected ? null : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            {t("settings.claudeSubscription.howTo")}{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
              claude setup-token
            </code>
          </p>
          <div className="flex items-center gap-2">
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t("settings.claudeSubscription.tokenPlaceholder")}
            />
            <Button
              disabled={token.trim().length === 0 || connect.isPending}
              onClick={() => connect.mutate()}
            >
              {t("settings.claudeSubscription.connect")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
