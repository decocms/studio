import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ChevronRight } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
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
  useGitProviderCapabilities,
  useConnectGitAccountToken,
} from "@/hooks/use-git-providers";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";
function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
export function GitAccountConnect({
  layout = "buttons",
  disabled = false,
}: {
  layout?: "buttons" | "picker";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ConnectActions
        layout={layout}
        disabled={disabled}
        onTokenDialog={() => setOpen(true)}
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

function ConnectAction({
  layout,
  label,
  description,
  icon,
  href,
  onClick,
  disabled,
}: {
  layout: "buttons" | "picker";
  label: string;
  description: string;
  icon: ReactNode;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const content =
    layout === "picker" ? (
      <>
        <span className="size-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
          {icon}
        </span>
        <span className="flex-1 min-w-0 text-left">
          <span className="block text-sm font-medium">{label}</span>
          <span className="block text-xs font-normal text-muted-foreground whitespace-normal">
            {description}
          </span>
        </span>
        {!disabled && (
          <span className="shrink-0 text-muted-foreground">
            <ChevronRight size={16} />
          </span>
        )}
      </>
    ) : (
      <>
        {icon}
        {label}
      </>
    );
  const button = (
    <Button
      size="sm"
      variant={layout === "picker" ? "ghost" : "outline"}
      className={cn(
        layout === "picker" &&
          "w-full h-auto justify-start gap-3 rounded-none px-4 py-3 hover:bg-accent",
      )}
      aria-label={label}
      disabled={disabled}
      asChild={!!href && !disabled}
      onClick={onClick}
    >
      {href && !disabled ? <a href={href}>{content}</a> : content}
    </Button>
  );
  return layout === "buttons" && disabled ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0}>{button}</span>
      </TooltipTrigger>
      <TooltipContent>{description}</TooltipContent>
    </Tooltip>
  ) : (
    button
  );
}

function ConnectActions({
  layout,
  disabled,
  onTokenDialog,
}: {
  layout: "buttons" | "picker";
  disabled: boolean;
  onTokenDialog: () => void;
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
    <div
      className={cn(
        "flex",
        layout === "picker" ? "flex-col" : "flex-wrap items-center gap-2",
      )}
    >
      <ConnectAction
        layout={layout}
        label={t("settings.repositories.addGithubAccount")}
        description={t(
          githubConfigured
            ? "settings.repositories.browseAccount"
            : "settings.repositories.githubUnavailable",
        )}
        icon={<GitHubIcon size={16} />}
        href={github?.connectPath ? connectUrl(github.connectPath) : undefined}
        disabled={disabled || !githubConfigured || !github?.connectPath}
      />
      {gitlabConfigured && gitlab?.connectPath && (
        <ConnectAction
          layout={layout}
          label={t("settings.repositories.connectGitlab")}
          description={t("settings.repositories.browseAccount")}
          icon={<GitLabIcon size={16} />}
          href={connectUrl(gitlab.connectPath)}
          disabled={disabled}
        />
      )}
      <ConnectAction
        layout={layout}
        label={t("settings.repositories.connectGitlabToken")}
        description={t("settings.repositories.gitlabTokenHint")}
        icon={<GitLabIcon size={16} />}
        onClick={onTokenDialog}
        disabled={disabled}
      />
    </div>
  );
}
