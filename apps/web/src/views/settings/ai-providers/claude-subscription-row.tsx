/**
 * Link your own Claude subscription, so sandbox-hosted claude-code runs bill
 * against your plan instead of the org's AI credit.
 *
 * The token is minted by Anthropic's own client (`claude setup-token`) and
 * pasted here — so the user picks which account pays, in Anthropic's UI, and
 * Studio never has to guess.
 */
import { useState } from "react";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@decocms/ui/components/dropdown-menu.tsx";
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
import { useClaudeSubscription } from "./use-claude-subscription";

export function ClaudeSubscriptionRow() {
  const t = useT();
  const [token, setToken] = useState("");
  const [linking, setLinking] = useState(false);
  const { orgId, userId, connected, expired, linkedAt, connect, disconnect } =
    useClaudeSubscription();
  const usage = useSubscriptionUsage({
    provider: "claude",
    orgId,
    userId,
    linkedAt,
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
          onSubmit={() =>
            connect.mutate(token, {
              onSuccess: () => {
                setToken("");
                setLinking(false);
              },
            })
          }
          inputProps={{
            placeholder: t("settings.claudeSubscription.tokenPlaceholder"),
            "aria-label": t("settings.claudeSubscription.tokenPlaceholder"),
          }}
        />
      )}
    </AccountRow>
  );
}
