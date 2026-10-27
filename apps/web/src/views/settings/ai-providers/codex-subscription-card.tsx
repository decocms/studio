import { SubscriptionUsage } from "./subscription-usage";
import { authClient } from "@/lib/auth-client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import {
  SettingsCard,
  SettingsSection,
} from "@/components/settings/settings-section";
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
    enabled: Boolean(userId),
  });

  const invalidate = async () => {
    await queryClient.cancelQueries({
      queryKey: KEYS.subscriptionUsage(org.id, userId, "codex"),
    });
    queryClient.removeQueries({
      queryKey: KEYS.subscriptionUsage(org.id, userId, "codex"),
    });
    await queryClient.invalidateQueries({
      queryKey: KEYS.codexSubscription(org.id, userId),
    });
  };

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
    <SettingsSection
      title={t("settings.codexSubscription.title")}
      description={
        connected
          ? t("settings.codexSubscription.active")
          : t("settings.codexSubscription.description")
      }
      actions={
        connected ? (
          <Button
            variant="outline"
            size="sm"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate()}
          >
            {t("settings.codexSubscription.disconnect")}
          </Button>
        ) : null
      }
    >
      {connected && (
        <SettingsCard>
          <SubscriptionUsage
            provider="codex"
            orgId={org.id}
            userId={userId}
            linkedAt={status.data?.linkedAt ?? null}
          />
        </SettingsCard>
      )}
      {connected ? null : (
        <SettingsCard>
          <div className="flex flex-col gap-2 p-4">
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
        </SettingsCard>
      )}
    </SettingsSection>
  );
}
