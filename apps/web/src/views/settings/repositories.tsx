/**
 * Settings → Repositories — the org's first-class git integration.
 *
 * Two sections: the provider accounts the org has connected (GitHub App /
 * OAuth / GitLab token) and the repositories linked against them. A repository
 * can also be linked without an account, in which case it is an anonymous
 * public clone — which is what a repository degrades to when its account is
 * disconnected.
 */

import type { GitProviderKind } from "@decocms/shared/git-providers";
import { GitAccountConnect } from "@/components/git-account-connect";
import { GithubConnectDialog } from "@/components/github-connect-dialog";
import { useProjectContext } from "@/sdk";
import { RepositoryPicker } from "@/components/repository-picker";

import { useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { useState } from "react";
import { useSearch, useNavigate } from "@tanstack/react-router";
import { GitBranch01, LinkExternal01, Plus } from "@untitledui/icons";
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

import { Skeleton } from "@decocms/ui/components/skeleton.tsx";

import { GitProviderIcon } from "@/components/icons/git-provider-icon";
import { SettingsGroupPage } from "@/components/settings/settings-group-page";
import { SettingsSection } from "@/components/settings/settings-section";
import {
  type GitAccount,
  type Repository,
  useDeleteGitAccount,
  useDeleteRepository,
  useGitAccounts,
  useGitProviderCapabilities,
  useRepositories,
} from "@/hooks/use-git-providers";
import { useT } from "@/i18n/use-t.ts";

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

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function authKindLabel(
  account: GitAccount,
  t: ReturnType<typeof useT>,
): string {
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
  const needsReconnect = account.status === "revoked" || !account.servable;
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 py-3 border-b border-border/60 last:border-b-0">
      <div className="flex items-start gap-3 min-w-0">
        <Avatar
          url={account.avatarUrl?.trim() || undefined}
          fallback={<ProviderIcon provider={account.type} />}
          shape="circle"
          size="sm"
          className="size-9"
          muted
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">
              {account.login}
            </span>
            {needsReconnect && (
              <Badge variant="outline" className="shrink-0">
                {t("settings.repositories.needsReconnect")}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            {account.host} · {authKindLabel(account, t)}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {account.connectedBy
              ? t("settings.repositories.connectedBy", {
                  name: account.connectedBy.name,
                })
              : t("settings.repositories.connectedByUnknown")}
          </p>
          {needsReconnect && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("settings.repositories.needsReconnectHint")}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2 max-w-full">
        {account.type === "github" &&
          account.installationId &&
          capabilities.data?.github.connectPath && (
            <Button variant="outline" size="sm" asChild>
              <a
                href={`${capabilities.data.github.connectPath}?returnTo=${encodeURIComponent(`/${org.slug}/settings/repositories`)}`}
              >
                {t("settings.repositories.githubEditWorkspaceAccess")}
              </a>
            </Button>
          )}
        {account.type === "github" &&
          account.installationId &&
          account.servable && (
            <Button variant="outline" size="sm" asChild>
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
                <LinkExternal01 size={14} />
                {t("settings.repositories.manageRepositoryAccess")}
              </a>
            </Button>
          )}
        <Button variant="outline" size="sm" onClick={onDisconnect}>
          {t("settings.repositories.disconnect")}
        </Button>
      </div>
    </div>
  );
}

function RepositoryRow({
  repository,
  onUnlink,
}: {
  repository: Repository;
  onUnlink: () => void;
}) {
  const t = useT();
  const visibility = visibilityLabel(repository.visibility, t);
  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b border-border/60 last:border-b-0">
      <div className="flex items-start gap-3 min-w-0">
        <div className="size-9 rounded-md bg-muted flex items-center justify-center shrink-0">
          <ProviderIcon provider={repository.provider} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">
              {repository.path}
            </span>
            {visibility && (
              <Badge variant="secondary" className="shrink-0">
                {visibility}
              </Badge>
            )}
            {!repository.accountId && (
              <Badge variant="outline" className="shrink-0">
                {t("settings.repositories.anonymousClone")}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            {repository.host}
            {repository.defaultBranch
              ? ` · ${t("settings.repositories.defaultBranch", {
                  branch: repository.defaultBranch,
                })}`
              : ""}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button variant="ghost" size="sm" asChild>
          <a
            href={repository.webUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={t("settings.repositories.openInProvider")}
          >
            <LinkExternal01 size={14} />
          </a>
        </Button>
        <Button variant="outline" size="sm" onClick={onUnlink}>
          {t("settings.repositories.unlink")}
        </Button>
      </div>
    </div>
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
      headerClassName="flex-col items-start 2xl:flex-row 2xl:items-center [&>div]:max-w-full"
      description={t("settings.repositories.accountsDescription")}
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
        <section
          data-testid="git-accounts-list"
          className="rounded-2xl border border-border/60 bg-background px-5 py-2"
        >
          {rows.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              onDisconnect={() => onDisconnect(account)}
            />
          ))}
        </section>
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
  if (repositories.isError) throw repositories.error;
  const rows = repositories.data ?? [];

  return (
    <SettingsSection
      title={t("settings.repositories.reposTitle")}
      description={t("settings.repositories.reposDescription")}
      actions={
        rows.length > 0 ? (
          <Button size="sm" onClick={onAdd}>
            <Plus size={14} />
            {t("settings.repositories.addRepository")}
          </Button>
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
          <Button size="sm" onClick={onAdd}>
            <Plus size={14} />
            {t("settings.repositories.addRepository")}
          </Button>
        </div>
      ) : (
        <section
          data-testid="repositories-list"
          className="rounded-2xl border border-border/60 bg-background px-5 py-2"
        >
          {rows.map((repository) => (
            <RepositoryRow
              key={repository.id}
              repository={repository}
              onUnlink={() => onUnlink(repository)}
            />
          ))}
        </section>
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
      <p className="text-sm text-muted-foreground">
        {t("settings.repositories.pageDescription")}
      </p>

      {!search.git_flow && <ConnectError />}
      {search.git_flow && (
        <GithubConnectDialog
          flowId={search.git_flow}
          returning={search.git_return === true}
          onClose={() =>
            void navigate({
              to: ".",
              search: (prev) => ({
                ...prev,
                git_flow: undefined,
                git_return: undefined,
                git_error: undefined,
              }),
              replace: true,
            })
          }
        />
      )}

      <AccountsSection onDisconnect={setPendingAccount} />

      <RepositoriesSection
        onAdd={() => setAddOpen(true)}
        onUnlink={setPendingRepository}
      />

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
