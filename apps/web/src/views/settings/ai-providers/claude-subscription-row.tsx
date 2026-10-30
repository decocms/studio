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
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { authClient } from "@/lib/auth-client";
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

export function ClaudeSubscriptionRow() {
  const t = useT();
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const userId = session?.user.id ?? "";
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const [linking, setLinking] = useState(false);

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
    mutationFn: () => studio.call("CLAUDE_SUBSCRIPTION_CONNECT", { token }),
    onSuccess: async () => {
      setToken("");
      setLinking(false);
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
  const usage = useSubscriptionUsage({
    provider: "claude",
    orgId: org.id,
    userId,
    linkedAt: status.data?.linkedAt ?? null,
    enabled: connected,
  });

  return (
    <AccountRow
      icon={
        <AccountLogo
          src={PROVIDER_LOGOS["claude-code"]}
          alt={t("settings.claudeSubscription.title")}
        />
      }
      title={t("settings.claudeSubscription.title")}
      status={connected ? "linked" : expired ? "expired" : null}
      summary={connected ? <SubscriptionUsageSummary query={usage} /> : null}
      action={
        connected ? (
          <AccountMenu>
            <SubscriptionUsageMenuItems provider="claude" query={usage} />
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={disconnect.isPending}
              onSelect={() => disconnect.mutate()}
            >
              {t("settings.claudeSubscription.disconnect")}
            </DropdownMenuItem>
          </AccountMenu>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLinking((open) => !open);
              setToken("");
            }}
          >
            {linking
              ? t("settings.ownAccounts.cancel")
              : t("settings.claudeSubscription.connect")}
          </Button>
        )
      }
    >
      {!connected && linking && (
        <LinkTokenForm
          hint={
            <>
              {t("settings.claudeSubscription.howTo")}{" "}
              <code className="rounded bg-muted px-1.5 py-0.5">
                claude setup-token
              </code>
            </>
          }
          submitLabel={t("settings.claudeSubscription.connect")}
          pending={connect.isPending}
          value={token}
          onChange={setToken}
          onSubmit={() => connect.mutate()}
          inputProps={{
            placeholder: t("settings.claudeSubscription.tokenPlaceholder"),
            "aria-label": t("settings.claudeSubscription.tokenPlaceholder"),
          }}
        />
      )}
    </AccountRow>
  );
}
