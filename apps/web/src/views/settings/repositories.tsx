import { Page } from "@/components/page";
/**
 * Settings → Repositories — the org's first-class git integration.
 *
 * Two sections: the provider accounts the org has connected (GitHub App /
 * OAuth / GitLab token) and the repositories linked against them. A repository
 * can also be linked without an account, in which case it is an anonymous
 * public clone — which is what a repository degrades to when its account is
 * disconnected.
 */

import {
  DEFAULT_HOSTS,
  type GitProviderKind,
} from "@decocms/shared/git-providers";
import { GitAccountConnect } from "@/components/git-account-connect";
import { GithubConnectDialog } from "@/components/github-connect-dialog";
import { useProjectContext } from "@/sdk";
import { RepositoryPicker } from "@/components/repository-picker";

import { useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { Fragment, type ReactNode, useState } from "react";
import { useSearch, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  Container,
  DotsHorizontal,
  GitBranch01,
  LinkBroken01,
  LinkExternal01,
  Plus,
  Users01,
} from "@untitledui/icons";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Alert, AlertDescription } from "@decocms/ui/components/alert.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { IconButton } from "@decocms/ui/components/icon-button.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";

import { GitProviderIcon } from "@/components/icons/git-provider-icon";
import { SettingsGroupPage } from "@/components/settings/settings-group-page";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import { GitCredentialsSection } from "@/components/settings/git-credentials-section";
import {
  type GitAccount,
  type Repository,
  useDeleteGitAccount,
  useDeleteRepository,
  useUpdateRepository,
  useGitAccounts,
  useGitProviderCapabilities,
  useRepositories,
} from "@/hooks/use-git-providers";
import { useT } from "@/i18n/use-t.ts";
import { errorMessage } from "@/lib/error-message";

function ProviderIcon({
  provider,
  size = 16,
}: {
  provider: GitProviderKind;
  size?: number;
}) {
  return (
    <GitProviderIcon
      provider={provider}
      size={size}
      className="text-muted-foreground"
    />
  );
}

function authKindLabel(
  account: GitAccount,
  t: ReturnType<typeof useT>,
): string {
  if (account.authKind === "github_cli") {
    return t("settings.repositories.authKindGithubCli");
  }
  if (account.authKind === "github_app") {
    return t("settings.repositories.authKindGithubApp");
  }
  if (account.authKind === "oauth") {
    return t("settings.repositories.authKindOauth");
  }
  return t("settings.repositories.authKindToken");
}

function visibilityLabel(
  visibility: Repository["visibility"],
  t: ReturnType<typeof useT>,
): string | null {
  if (visibility === "public") {
    return t("settings.repositories.visibilityPublic");
  }
  if (visibility === "private") {
    return t("settings.repositories.visibilityPrivate");
  }
  if (visibility === "internal") {
    return t("settings.repositories.visibilityInternal");
  }
  return null;
}

const ACCESS_ISSUE_COPY = {
  revoked: {
    label: "settings.repositories.accessRevoked",
    hint: "settings.repositories.accessRevokedHint",
  },
  provider_unavailable: {
    label: "settings.repositories.providerUnavailable",
    hint: "settings.repositories.providerUnavailableHint",
  },
  installation_missing: {
    label: "settings.repositories.installationMissing",
    hint: "settings.repositories.installationMissingHint",
  },
  authorization_required: {
    label: "settings.repositories.authorizationRequired",
    hint: "settings.repositories.authorizationRequiredHint",
  },
  no_repositories: {
    label: "settings.repositories.noAuthorizedRepositories",
    hint: "settings.repositories.noAuthorizedRepositoriesHint",
  },
} as const;

/** Host in the meta line only when it says something: a self-hosted instance. */
function customHost(provider: GitProviderKind, host: string): string | null {
  return host === DEFAULT_HOSTS[provider] ? null : host;
}

function MetaLine({ parts }: { parts: ReactNode[] }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <span aria-hidden="true">·</span>}
          <span className="truncate">{part}</span>
        </Fragment>
      ))}
    </span>
  );
}

function AccessWarning({ label, hint }: { label: string; hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="focus-ring inline-flex shrink-0 items-center gap-1 rounded-sm text-xs font-normal text-warning"
        >
          <AlertTriangle size={12} aria-hidden="true" />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{hint}</TooltipContent>
    </Tooltip>
  );
}

function needsAttention(account: GitAccount): boolean {
  return account.status === "revoked" || !account.servable;
}

function RowMenu({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={t("settings.repositories.moreActions")}>
          <DotsHorizontal size={16} />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AccountRow({
  account,
  onDisconnect,
}: {
  account: GitAccount;
  onDisconnect: () => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const capabilities = useGitProviderCapabilities();
  const attention = needsAttention(account);
  const isGithubApp =
    account.type === "github" && account.authKind === "github_app";
  const githubConnectPath = capabilities.data?.github.connectPath;
  const githubConnectHref = githubConnectPath
    ? `${githubConnectPath}?returnTo=${encodeURIComponent(`/${org.slug}/settings/repositories${account.installationId ? `?git_installation=${account.installationId}` : ""}`)}`
    : null;
  const accessCopy = account.accessIssue
    ? ACCESS_ISSUE_COPY[account.accessIssue]
    : null;
  const accessHint =
    isGithubApp && capabilities.isSuccess && !githubConnectPath
      ? t("settings.repositories.githubReconnectUnavailable")
      : t(accessCopy?.hint ?? "settings.repositories.accessUnavailableHint", {
          login: account.login,
        });
  const githubAction =
    account.accessIssue === "authorization_required"
      ? t("settings.repositories.authorizeWorkspaceAccess")
      : account.accessIssue === "no_repositories"
        ? t("settings.repositories.selectRepositories")
        : t("settings.repositories.githubReconnect");
  const host = customHost(account.type, account.host);

  return (
    <SettingsCardItem
      icon={
        <Avatar
          url={account.avatarUrl?.trim() || undefined}
          fallback={<ProviderIcon provider={account.type} />}
          shape="circle"
          size="sm"
          className="size-8"
          muted
        />
      }
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{account.login}</span>
          {attention && (
            <AccessWarning
              label={t(
                accessCopy?.label ?? "settings.repositories.accessUnavailable",
              )}
              hint={accessHint}
            />
          )}
        </span>
      }
      description={
        <MetaLine
          parts={[
            ...(host ? [host] : []),
            authKindLabel(account, t),
            account.connectedBy
              ? t("settings.repositories.connectedBy", {
                  name: account.connectedBy.name,
                })
              : t("settings.repositories.connectedByUnknown"),
          ]}
        />
      }
      action={
        <div className="flex items-center gap-1">
          {attention && isGithubApp && githubConnectHref && (
            <Button variant="outline" size="sm" asChild>
              <a href={githubConnectHref}>{githubAction}</a>
            </Button>
          )}
          <RowMenu>
            {!attention && isGithubApp && githubConnectHref && (
              <DropdownMenuItem asChild>
                <a href={githubConnectHref}>
                  <Users01 />
                  {t("settings.repositories.githubEditWorkspaceAccess")}
                </a>
              </DropdownMenuItem>
            )}
            {!attention &&
              account.type === "github" &&
              account.installationId && (
                <DropdownMenuItem asChild>
                  <a
                    href={`/api/${encodeURIComponent(org.slug)}/git-providers/github/accounts/${encodeURIComponent(account.id)}/manage`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => {
                      void queryClient.invalidateQueries({
                        queryKey: KEYS.providerRepoSearch(
                          org.id,
                          account.id,
                          "",
                        ).slice(0, 3),
                        refetchType: "none",
                      });
                    }}
                  >
                    <LinkExternal01 />
                    {t("settings.repositories.manageRepositoryAccess")}
                  </a>
                </DropdownMenuItem>
              )}
            {!attention && account.type === "github" && (
              <DropdownMenuSeparator />
            )}
            <DropdownMenuItem variant="destructive" onSelect={onDisconnect}>
              <LinkBroken01 />
              {t("settings.repositories.disconnect")}
            </DropdownMenuItem>
          </RowMenu>
        </div>
      }
    />
  );
}

/**
 * Which image this repo's sandboxes boot from. Changing it affects the NEXT
 * sandbox: a running one keeps the image it was claimed with, because a
 * SandboxClaim names its template once and the pod cannot be re-imaged.
 */
function SandboxImageMenu({ repository }: { repository: Repository }) {
  const t = useT();
  const update = useUpdateRepository();
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={update.isPending}>
        <Container />
        {t("settings.repositories.sandboxImageLabel")}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup
          value={repository.sandboxImage}
          onValueChange={(value) =>
            update.mutate(
              { id: repository.id, sandboxImage: value },
              {
                onError: (error) =>
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : t("settings.repositories.sandboxImageError"),
                  ),
              },
            )
          }
        >
          <DropdownMenuRadioItem value="default">
            {t("settings.repositories.sandboxImageDefault")}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="android">
            {t("settings.repositories.sandboxImageAndroid")}
          </DropdownMenuRadioItem>
          {/* A variant set through REPOSITORY_UPDATE that this list doesn't
              name still has to show as the current value. */}
          {repository.sandboxImage !== "default" &&
            repository.sandboxImage !== "android" && (
              <DropdownMenuRadioItem value={repository.sandboxImage}>
                {repository.sandboxImage}
              </DropdownMenuRadioItem>
            )}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function sandboxImageLabel(
  image: string,
  t: ReturnType<typeof useT>,
): string | null {
  if (image === "default") return null;
  if (image === "android") {
    return t("settings.repositories.sandboxImageAndroid");
  }
  return image;
}

function RepositoryRow({
  repository,
  account,
  onUnlink,
}: {
  repository: Repository;
  account: GitAccount | undefined;
  onUnlink: () => void;
}) {
  const t = useT();
  const visibility = visibilityLabel(repository.visibility, t);
  const host = customHost(repository.provider, repository.host);
  const image = sandboxImageLabel(repository.sandboxImage, t);
  const meta: ReactNode[] = [
    ...(visibility ? [visibility] : []),
    ...(repository.defaultBranch
      ? [
          <span key="branch" className="inline-flex items-center gap-1">
            <GitBranch01 size={12} aria-hidden="true" />
            {repository.defaultBranch}
          </span>,
        ]
      : []),
    ...(host ? [host] : []),
  ];
  return (
    <SettingsCardItem
      icon={<ProviderIcon provider={repository.provider} />}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{repository.path}</span>
          {!repository.accountId && (
            <Badge variant="muted">
              {t("settings.repositories.anonymousClone")}
            </Badge>
          )}
          {image && <Badge variant="muted">{image}</Badge>}
          {account && needsAttention(account) && (
            <AccessWarning
              label={t("settings.repositories.accessUnavailable")}
              hint={t("settings.repositories.repoAccountNeedsAttention", {
                login: account.login,
              })}
            />
          )}
        </span>
      }
      description={meta.length > 0 ? <MetaLine parts={meta} /> : undefined}
      action={
        <RowMenu>
          <DropdownMenuItem asChild>
            <a href={repository.webUrl} target="_blank" rel="noreferrer">
              <LinkExternal01 />
              {t("settings.repositories.openInProvider")}
            </a>
          </DropdownMenuItem>
          <SandboxImageMenu repository={repository} />
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onUnlink}>
            <LinkBroken01 />
            {t("settings.repositories.unlink")}
          </DropdownMenuItem>
        </RowMenu>
      }
    />
  );
}

function AccountsSection({
  onDisconnect,
}: {
  onDisconnect: (account: GitAccount) => void;
}) {
  const t = useT();
  const capabilities = useGitProviderCapabilities();
  const accounts = useGitAccounts();

  const githubConfigured = capabilities.data?.github.configured === true;
  const gitlabConfigured =
    (capabilities.data?.gitlab.oauthHosts.length ?? 0) > 0;
  const bitbucketConfigured =
    (capabilities.data?.bitbucket.oauthHosts.length ?? 0) > 0;
  const anyProviderConfigured =
    githubConfigured || gitlabConfigured || bitbucketConfigured;
  if (accounts.isError) throw accounts.error;
  const rows = accounts.data ?? [];

  return (
    <SettingsSection
      title={t("settings.repositories.accountsTitle")}
      actions={rows.length > 0 ? <GitAccountConnect /> : null}
    >
      {accounts.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : !anyProviderConfigured && rows.length === 0 ? (
        <div
          data-testid="git-accounts-list"
          className="rounded-2xl border border-dashed border-border/60 p-10 flex flex-col items-center justify-center text-center gap-3"
        >
          <p className="font-medium text-sm">
            {t("settings.repositories.noProvidersTitle")}
          </p>
          <p className="text-xs text-muted-foreground max-w-sm">
            {t("settings.repositories.noProvidersDescription")}
          </p>
          <GitAccountConnect />
        </div>
      ) : rows.length === 0 ? (
        <div
          data-testid="git-accounts-list"
          className="rounded-2xl border border-dashed border-border/60 p-10 flex flex-col items-center justify-center text-center gap-3"
        >
          <div className="size-12 rounded-full bg-muted flex items-center justify-center">
            <GitBranch01 size={20} className="text-muted-foreground" />
          </div>
          <div>
            <p className="font-medium text-sm">
              {t("settings.repositories.accountsEmptyTitle")}
            </p>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm">
              {t("settings.repositories.accountsEmptyDescription")}
            </p>
          </div>
          <GitAccountConnect />
        </div>
      ) : (
        <div data-testid="git-accounts-list">
          <SettingsCard>
            {rows.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                onDisconnect={() => onDisconnect(account)}
              />
            ))}
          </SettingsCard>
        </div>
      )}
    </SettingsSection>
  );
}

function RepositoriesSection({
  onAdd,
  onUnlink,
}: {
  onAdd: () => void;
  onUnlink: (repository: Repository) => void;
}) {
  const t = useT();
  const repositories = useRepositories();
  const accounts = useGitAccounts();
  if (repositories.isError) throw repositories.error;
  const rows = repositories.data ?? [];
  const accountById = new Map(
    (accounts.data ?? []).map((account) => [account.id, account]),
  );

  return (
    <SettingsSection
      title={t("settings.repositories.reposTitle")}
      actions={
        rows.length > 0 ? (
          <Page.Actions>
            <Button size="sm" onClick={onAdd}>
              <Plus size={14} />
              {t("settings.repositories.addRepository")}
            </Button>
          </Page.Actions>
        ) : null
      }
    >
      {repositories.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : rows.length === 0 ? (
        <div
          data-testid="repositories-list"
          className="rounded-2xl border border-dashed border-border/60 p-10 flex flex-col items-center justify-center text-center gap-3"
        >
          <div>
            <p className="font-medium text-sm">
              {t("settings.repositories.reposEmptyTitle")}
            </p>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm">
              {t("settings.repositories.reposEmptyDescription")}
            </p>
          </div>
          <Page.Actions>
            <Button size="sm" onClick={onAdd}>
              <Plus size={14} />
              {t("settings.repositories.addRepository")}
            </Button>
          </Page.Actions>
        </div>
      ) : (
        <div data-testid="repositories-list">
          <SettingsCard>
            {rows.map((repository) => (
              <RepositoryRow
                key={repository.id}
                repository={repository}
                account={
                  repository.accountId
                    ? accountById.get(repository.accountId)
                    : undefined
                }
                onUnlink={() => onUnlink(repository)}
              />
            ))}
          </SettingsCard>
        </div>
      )}
    </SettingsSection>
  );
}

function ConnectError() {
  const t = useT();
  const navigate = useNavigate();
  const accounts = useGitAccounts();
  const error = useSearch({
    strict: false,
    select: (search) => search.git_error,
  });
  if (
    !error ||
    (error === "no_installations" &&
      accounts.data?.some((account) => account.type === "github"))
  )
    return null;

  let message: string;
  switch (error) {
    case "no_installations":
      message = t("settings.repositories.oauthNoInstallations");
      break;
    case "denied":
    case "access_denied":
      message = t("settings.repositories.oauthDenied");
      break;
    case "missing_state":
    case "invalid_state":
    case "session_mismatch":
      message = t("settings.repositories.oauthExpired");
      break;
    case "not_configured":
      message = t("settings.repositories.oauthNotConfigured");
      break;
    default:
      message = t("settings.repositories.oauthFailed");
  }
  return (
    <Alert variant={error === "no_installations" ? "info" : "destructive"}>
      <AlertDescription className="flex-1">{message}</AlertDescription>
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          void navigate({
            to: ".",
            search: (prev) => ({ ...prev, git_error: undefined }),
            replace: true,
          })
        }
      >
        {t("settings.repositories.dismiss")}
      </Button>
    </Alert>
  );
}

function RepositoriesContent() {
  const t = useT();
  const navigate = useNavigate();
  const search = useSearch({ strict: false });
  const deleteAccount = useDeleteGitAccount();
  const deleteRepository = useDeleteRepository();

  const [addOpen, setAddOpen] = useState(false);
  const [pendingAccount, setPendingAccount] = useState<GitAccount | null>(null);
  const [pendingRepository, setPendingRepository] = useState<Repository | null>(
    null,
  );

  function handleDisconnect() {
    if (!pendingAccount) return;
    deleteAccount.mutate(pendingAccount.id, {
      onSuccess: () => toast.success(t("settings.repositories.disconnected")),
      onError: (err) =>
        toast.error(errorMessage(err, t("settings.repositories.failed"))),
      onSettled: () => setPendingAccount(null),
    });
  }

  function handleUnlink() {
    if (!pendingRepository) return;
    deleteRepository.mutate(pendingRepository.id, {
      onSuccess: () => toast.success(t("settings.repositories.unlinked")),
      onError: (err) =>
        toast.error(errorMessage(err, t("settings.repositories.failed"))),
      onSettled: () => setPendingRepository(null),
    });
  }

  return (
    <>
      {!search.git_flow && <ConnectError />}
      {search.git_flow && (
        <GithubConnectDialog
          key={search.git_flow}
          flowId={search.git_flow}
          initialInstallationId={search.git_installation}
          returning={search.git_return === true}
          onClose={() =>
            void navigate({
              to: ".",
              search: (prev) => ({
                ...prev,
                git_flow: undefined,
                git_installation: undefined,
                git_return: undefined,
                git_error: undefined,
              }),
              replace: true,
            })
          }
        />
      )}

      <RepositoriesSection
        onAdd={() => setAddOpen(true)}
        onUnlink={setPendingRepository}
      />

      <AccountsSection onDisconnect={setPendingAccount} />

      <GitCredentialsSection />

      {addOpen && (
        <RepositoryPicker
          open
          onOpenChange={setAddOpen}
          title={t("settings.repositories.addDialogTitle")}
          onPicked={() => setAddOpen(false)}
        />
      )}

      <AlertDialog
        open={pendingAccount !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAccount(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.repositories.disconnectTitle", {
                login: pendingAccount?.login ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.repositories.disconnectDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("settings.repositories.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleDisconnect}>
              {t("settings.repositories.disconnect")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingRepository !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRepository(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.repositories.unlinkTitle", {
                path: pendingRepository?.path ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.repositories.unlinkDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("settings.repositories.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleUnlink}>
              {t("settings.repositories.unlink")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function OrgRepositoriesPage() {
  return (
    <SettingsGroupPage group="repositories">
      <RepositoriesContent />
    </SettingsGroupPage>
  );
}
