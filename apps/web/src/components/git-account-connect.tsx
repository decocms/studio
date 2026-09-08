import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { GitHubIcon } from "@/components/icons/github-icon";
import { GitLabIcon } from "@/components/icons/gitlab-icon";
import {
  useGitAccounts,
  useGitProviderCapabilities,
  useConnectGitAccountToken,
} from "@/hooks/use-git-providers";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";
function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
export function GitAccountConnect() {
  const [open, setOpen] = useState(false);
  const accounts = useGitAccounts();
  return (
    <>
      <ConnectActions
        onTokenDialog={() => setOpen(true)}
        hasGithubAccount={(accounts.data ?? []).some(
          (a) => a.type === "github",
        )}
      />
      {open && <TokenConnectDialog open onOpenChange={setOpen} />}
    </>
  );
}
function TokenConnectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const connect = useConnectGitAccountToken();
  const [host, setHost] = useState("gitlab.com");
  const [token, setToken] = useState("");

  function handleConnect() {
    if (!host.trim() || !token.trim()) return;
    connect.mutate(
      { type: "gitlab", host: host.trim(), token: token.trim() },
      {
        onSuccess: (account) => {
          toast.success(
            t("settings.repositories.connected", { login: account.login }),
          );
          setToken("");
          onOpenChange(false);
        },
        onError: (err) =>
          toast.error(errorMessage(err, t("settings.repositories.failed"))),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("settings.repositories.tokenDialogTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("settings.repositories.tokenDialogDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gitlab-host">
              {t("settings.repositories.tokenHostLabel")}
            </Label>
            <Input
              id="gitlab-host"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder={t("settings.repositories.tokenHostPlaceholder")}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gitlab-token">
              {t("settings.repositories.tokenLabel")}
            </Label>
            <Input
              id="gitlab-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t("settings.repositories.tokenPlaceholder")}
              autoComplete="off"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={connect.isPending}
          >
            {t("settings.repositories.cancel")}
          </Button>
          <Button
            onClick={handleConnect}
            disabled={!host.trim() || !token.trim() || connect.isPending}
          >
            {connect.isPending
              ? t("settings.repositories.connecting")
              : t("settings.repositories.connect")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConnectActions({
  onTokenDialog,
  hasGithubAccount,
}: {
  onTokenDialog: () => void;
  hasGithubAccount: boolean;
}) {
  const t = useT();
  const capabilities = useGitProviderCapabilities();
  const { org } = useProjectContext();
  const returnTo = `/${org.slug}/settings/repositories`;
  const connectUrl = (path: string) =>
    `${path}?returnTo=${encodeURIComponent(returnTo)}`;
  if (capabilities.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        {capabilities.error.message}
      </p>
    );
  const github = capabilities.data?.github;
  const gitlab = capabilities.data?.gitlab;

  const githubConfigured = github?.configured === true;
  const gitlabConfigured = (gitlab?.oauthHosts.length ?? 0) > 0;

  if (capabilities.isPending) {
    return <Skeleton className="h-9 w-40" />;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {!githubConfigured && (
        <div className="flex flex-col gap-1">
          <Button size="sm" variant="outline" disabled>
            <GitHubIcon size={14} />
            {t("settings.repositories.connectGithub")}
          </Button>
          <p className="text-xs text-muted-foreground">
            {t("settings.repositories.githubUnavailable")}
          </p>
        </div>
      )}
      {githubConfigured && github?.connectPath && (
        <Button size="sm" asChild>
          <a href={connectUrl(github.connectPath)}>
            <GitHubIcon size={14} />
            {t("settings.repositories.connectGithub")}
          </a>
        </Button>
      )}
      {githubConfigured && hasGithubAccount && github?.installPath && (
        <Button size="sm" variant="outline" asChild>
          <a href={connectUrl(github.installPath)}>
            {t("settings.repositories.installGithub")}
          </a>
        </Button>
      )}
      {gitlabConfigured && gitlab?.connectPath && (
        <Button size="sm" variant="outline" asChild>
          <a href={connectUrl(gitlab.connectPath)}>
            <GitLabIcon size={14} />
            {t("settings.repositories.connectGitlab")}
          </a>
        </Button>
      )}
      <Button size="sm" variant="outline" onClick={onTokenDialog}>
        <GitLabIcon size={14} />
        {t("settings.repositories.connectGitlabToken")}
      </Button>
    </div>
  );
}
