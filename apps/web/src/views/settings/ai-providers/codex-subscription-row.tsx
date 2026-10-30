/**
 * Link your own ChatGPT subscription, so Codex sandbox chats bill against
 * your plan instead of the org's AI credit.
 */
import { authClient } from "@/lib/auth-client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useT } from "@/i18n/use-t.ts";
import { PROVIDER_LOGOS } from "@/utils/ai-providers-logos";
import {
  AccountLogo,
  AccountMenu,
  AccountRow,
  LinkTokenForm,
} from "./account-row";
import {
  SubscriptionUsageMenuItems,
  SubscriptionUsageSummary,
  useSubscriptionUsage,
} from "./subscription-usage";

export function CodexSubscriptionRow() {
  const t = useT();
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const userId = session?.user.id ?? "";
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const [linking, setLinking] = useState(false);

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
      setLinking(false);
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
  const usage = useSubscriptionUsage({
    provider: "codex",
    orgId: org.id,
    userId,
    linkedAt: status.data?.linkedAt ?? null,
    enabled: connected,
  });

  return (
    <AccountRow
      icon={
        <AccountLogo
          src={PROVIDER_LOGOS.codex}
          alt={t("settings.codexSubscription.title")}
        />
      }
      title={t("settings.codexSubscription.title")}
      status={connected ? "linked" : null}
      summary={connected ? <SubscriptionUsageSummary query={usage} /> : null}
      action={
        connected ? (
          <AccountMenu>
            <SubscriptionUsageMenuItems provider="codex" query={usage} />
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={disconnect.isPending}
              onSelect={() => disconnect.mutate()}
            >
              {t("settings.codexSubscription.disconnect")}
            </DropdownMenuItem>
          </AccountMenu>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLinking((open) => !open)}
          >
            {t("settings.codexSubscription.connect")}
          </Button>
        )
      }
    >
      {!connected && linking && (
        <LinkTokenForm
          hint={
            <>
              {t("settings.codexSubscription.howTo")}{" "}
              <code className="rounded bg-muted px-1.5 py-0.5">
                codex login -c cli_auth_credentials_store='"file"'
              </code>
            </>
          }
          submitLabel={t("settings.codexSubscription.connect")}
          pending={connect.isPending}
          value={token}
          onChange={setToken}
          onSubmit={() => connect.mutate()}
          inputProps={{
            autoComplete: "off",
            maxLength: 131072,
            placeholder: t("settings.codexSubscription.tokenPlaceholder"),
            "aria-label": t("settings.codexSubscription.tokenPlaceholder"),
          }}
        />
      )}
    </AccountRow>
  );
}
