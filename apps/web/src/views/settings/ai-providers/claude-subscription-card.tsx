/**
 * Link your own Claude subscription, so sandbox-hosted claude-code runs bill
 * against your plan instead of the org's AI credit.
 *
 * Anthropic's OAuth flow redirects to its own console page, which we cannot
 * receive a callback on, so this is the same copy/paste flow the `claude` CLI
 * uses: open the URL, authorize, paste back the code it shows.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useT } from "@/i18n/use-t.ts";

export function ClaudeSubscriptionCard() {
  const t = useT();
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [stateToken, setStateToken] = useState<string | null>(null);

  const status = useQuery({
    queryKey: KEYS.claudeSubscription(org.id),
    queryFn: () => studio.call("CLAUDE_SUBSCRIPTION_STATUS", {}),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: KEYS.claudeSubscription(org.id),
    });

  const start = useMutation({
    mutationFn: () => studio.call("CLAUDE_SUBSCRIPTION_LOGIN_URL", {}),
    onSuccess: (res) => {
      setStateToken(res.stateToken);
      window.open(res.url, "_blank", "noopener,noreferrer");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const connect = useMutation({
    mutationFn: () =>
      studio.call("CLAUDE_SUBSCRIPTION_CONNECT", {
        code,
        stateToken: stateToken!,
      }),
    onSuccess: async () => {
      setCode("");
      setStateToken(null);
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
  // A row that exists but is not `connected` is an expired link — the only
  // state where "re-link" is the honest label.
  const expired = !connected && Boolean(status.data?.expiresAt);

  return (
    <div className="rounded-xl border border-border px-6 py-5 flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-base font-semibold">
            {t("settings.claudeSubscription.title")}
          </p>
          <p className="text-sm text-muted-foreground">
            {connected
              ? t("settings.claudeSubscription.activeUntil", {
                  expiresAt: new Date(status.data!.expiresAt!).toLocaleString(),
                })
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
        ) : (
          <Button
            variant="outline"
            disabled={start.isPending}
            onClick={() => start.mutate()}
          >
            {expired
              ? t("settings.claudeSubscription.relink")
              : t("settings.claudeSubscription.login")}
          </Button>
        )}
      </div>
      {stateToken ? (
        <div className="flex items-center gap-2">
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t("settings.claudeSubscription.codePlaceholder")}
          />
          <Button
            disabled={code.trim().length === 0 || connect.isPending}
            onClick={() => connect.mutate()}
          >
            {t("settings.claudeSubscription.finish")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
