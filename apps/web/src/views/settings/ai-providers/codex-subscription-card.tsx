import { authClient } from "@/lib/auth-client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useT } from "@/i18n/use-t.ts";

export function CodexSubscriptionCard() {
  const t = useT();
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const userId = session?.user.id ?? "";
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");

  const status = useQuery({
    queryKey: KEYS.codexSubscription(org.id, userId),
    queryFn: () => studio.call("CODEX_SUBSCRIPTION_STATUS", {}),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: KEYS.codexSubscription(org.id, userId),
    });

  const connect = useMutation({
    mutationFn: () =>
      studio.call("CODEX_SUBSCRIPTION_CONNECT", { authJson: token }),
    onSuccess: async () => {
      setToken("");
      await invalidate();
      toast.success(t("settings.codexSubscription.connected"));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const disconnect = useMutation({
    mutationFn: () => studio.call("CODEX_SUBSCRIPTION_DISCONNECT", {}),
    onSuccess: async () => {
      await invalidate();
      toast.success(t("settings.codexSubscription.disconnected"));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const connected = status.data?.connected === true;

  return (
    <div className="rounded-xl border border-border px-6 py-5 flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-base font-semibold">
            {t("settings.codexSubscription.title")}
          </p>
          <p className="text-sm text-muted-foreground">
            {connected
              ? t("settings.codexSubscription.active")
              : t("settings.codexSubscription.description")}
          </p>
        </div>
        {connected ? (
          <Button
            variant="outline"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate()}
          >
            {t("settings.codexSubscription.disconnect")}
          </Button>
        ) : null}
      </div>
      {connected ? null : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            {t("settings.codexSubscription.howTo")}{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
              codex login -c cli_auth_credentials_store='"file"'
            </code>
          </p>
          <div className="flex items-center gap-2">
            <Input
              type="password"
              autoComplete="off"
              maxLength={131072}
              aria-label={t("settings.codexSubscription.tokenPlaceholder")}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t("settings.codexSubscription.tokenPlaceholder")}
            />
            <Button
              disabled={token.trim().length === 0 || connect.isPending}
              onClick={() => connect.mutate()}
            >
              {t("settings.codexSubscription.connect")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
