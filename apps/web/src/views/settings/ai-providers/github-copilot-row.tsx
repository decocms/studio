/**
 * Link your own GitHub Copilot plan, so sandbox-hosted claude-code runs reach
 * Claude through Copilot and bill your seat instead of the org's AI credit.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

  return (
    <AccountRow
      icon={<GitHubIcon size={18} className="text-foreground" />}
      title={t("settings.githubCopilot.title")}
      status={connected ? "linked" : null}
      meta={
        orgShare && !orgShare.sharedByMe
          ? t("settings.githubCopilot.sharedBy", {
              name: orgShare.sharedBy.name ?? "",
            })
          : null
      }
      summary={
        connected ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <label className="flex shrink-0 cursor-pointer items-center gap-2 text-meta">
                {t("settings.githubCopilot.shareTitle")}
                <Switch
                  checked={orgShare?.sharedByMe === true}
                  disabled={share.isPending}
                  onCheckedChange={(checked) => share.mutate(checked)}
                />
              </label>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">
              {t("settings.githubCopilot.shareDescription")}
            </TooltipContent>
          </Tooltip>
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
