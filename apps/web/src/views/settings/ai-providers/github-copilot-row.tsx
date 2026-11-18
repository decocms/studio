/**
 * Link your own GitHub Copilot plan, so sandbox-hosted claude-code runs reach
 * Claude through Copilot and bill your seat instead of the org's AI credit.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { InfoCircle } from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useT } from "@/i18n/use-t.ts";
import { DropdownMenuItem } from "@decocms/ui/components/dropdown-menu.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { GitHubIcon } from "@/components/icons/github-icon";
import { AccountMenu, AccountRow, LinkTokenForm } from "./account-row";

const NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

export function GithubCopilotRow() {
  const t = useT();
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const [linking, setLinking] = useState(false);

  const status = useQuery({
    queryKey: KEYS.githubCopilot(org.id),
    queryFn: () => studio.call("GITHUB_COPILOT_STATUS", {}),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: KEYS.githubCopilot(org.id) });

  const connect = useMutation({
    mutationFn: () => studio.call("GITHUB_COPILOT_CONNECT", { token }),
    onSuccess: async () => {
      setToken("");
      setLinking(false);
      await invalidate();
      toast.success(t("settings.githubCopilot.connected"));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const disconnect = useMutation({
    mutationFn: () => studio.call("GITHUB_COPILOT_DISCONNECT", {}),
    onSuccess: async () => {
      await invalidate();
      toast.success(t("settings.githubCopilot.disconnected"));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const share = useMutation({
    mutationFn: (shared: boolean) =>
      studio.call("GITHUB_COPILOT_SHARE", { shared }),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
  });

  const connected = status.data?.connected === true;
  const orgShare = status.data?.orgShare ?? null;
  // Someone else holds the org's single share: theirs covers members without
  // a plan of their own, and the caller can't share until they stop.
  const otherShare = orgShare && !orgShare.sharedByMe ? orgShare : null;
  const sharerName = otherShare?.sharedBy.name ?? "";

  const shareSwitch = (
    <Switch
      checked={orgShare?.sharedByMe === true}
      disabled={share.isPending || otherShare !== null}
      onCheckedChange={(checked) => share.mutate(checked)}
      aria-label={t("settings.githubCopilot.shareTitle")}
    />
  );

  return (
    <AccountRow
      icon={<GitHubIcon size={18} className="text-foreground" />}
      title={t("settings.githubCopilot.title")}
      status={connected ? "linked" : null}
      meta={
        otherShare
          ? t(
              otherShare.coversMe
                ? "settings.githubCopilot.sharedBy"
                : "settings.githubCopilot.ownPlanUsed",
              { name: sharerName },
            )
          : null
      }
      summary={
        connected ? (
          <div className="flex shrink-0 items-center gap-2 text-meta">
            <span>{t("settings.githubCopilot.shareTitle")}</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={t("settings.githubCopilot.shareDescription")}
                >
                  <InfoCircle size={13} />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-64">
                {t("settings.githubCopilot.shareDescription")}
              </TooltipContent>
            </Tooltip>
            {otherShare ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* A disabled switch fires no pointer events; the span does. */}
                  <span>{shareSwitch}</span>
                </TooltipTrigger>
                <TooltipContent className="max-w-64">
                  {t("settings.githubCopilot.shareTaken", {
                    name: sharerName,
                  })}
                </TooltipContent>
              </Tooltip>
            ) : (
              shareSwitch
            )}
          </div>
        ) : null
      }
      action={
        connected ? (
          <AccountMenu>
            <DropdownMenuItem
              variant="destructive"
              disabled={disconnect.isPending}
              onSelect={() => disconnect.mutate()}
            >
              {t("settings.githubCopilot.disconnect")}
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
              : t("settings.githubCopilot.connect")}
          </Button>
        )
      }
    >
      {!connected && linking && (
        <LinkTokenForm
          hint={
            <a
              className="underline hover:text-foreground"
              href={NEW_TOKEN_URL}
              target="_blank"
              rel="noreferrer"
            >
              {t("settings.githubCopilot.howTo")}
            </a>
          }
          submitLabel={t("settings.githubCopilot.connect")}
          pending={connect.isPending}
          value={token}
          onChange={setToken}
          onSubmit={() => connect.mutate()}
          inputProps={{
            placeholder: t("settings.githubCopilot.tokenPlaceholder"),
            "aria-label": t("settings.githubCopilot.tokenPlaceholder"),
          }}
        />
      )}
    </AccountRow>
  );
}
