/**
 * Settings → Repositories — the org's first-class git integration.
 *
 * Two sections: the provider accounts the org has connected (GitHub App /
 * OAuth / GitLab token) and the repositories linked against them. A repository
 * can also be linked without an account, in which case it is an anonymous
 * public clone — which is what a repository degrades to when its account is
 * disconnected.
 */

import { useState } from "react";
import { LinkExternal01, Plus } from "@untitledui/icons";
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
import { Badge } from "@decocms/ui/components/badge.tsx";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@decocms/ui/components/tabs.tsx";
import { GitHubIcon } from "@/components/icons/github-icon";
import { GitLabIcon } from "@/components/icons/gitlab-icon";
import { SettingsGroupPage } from "@/components/settings/settings-group-page";
import { SettingsSection } from "@/components/settings/settings-section";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  type GitAccount,
  type ProviderRepository,
  type Repository,
  useConnectGitAccountToken,
  useDeleteGitAccount,
  useDeleteRepository,
  useGitAccounts,
  useGitProviderCapabilities,
  useLinkRepository,
  useRepositories,
  useSearchProviderRepositories,
} from "@/hooks/use-git-providers";
import { useT } from "@/i18n/use-t.ts";

const SEARCH_DEBOUNCE_MS = 300;

/** The account list is the picker's source of truth — an anonymous link is the
 *  explicit "no account" option, encoded as this sentinel in the Select. */
const NO_ACCOUNT = "__none__";

function ProviderIcon({
  provider,
  size = 16,
}: {
  provider: "github" | "gitlab";
  size?: number;
}) {
  return provider === "gitlab" ? (
    <GitLabIcon size={size} className="text-muted-foreground" />
  ) : (
    <GitHubIcon size={size} className="text-muted-foreground" />
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
  const needsReconnect = account.status === "revoked" || !account.servable;
  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b border-border/60 last:border-b-0">
      <div className="flex items-start gap-3 min-w-0">
        <div className="size-9 rounded-md bg-muted flex items-center justify-center shrink-0">
          <ProviderIcon provider={account.type} />
        </div>
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
          {needsReconnect && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("settings.repositories.needsReconnectHint")}
            </p>
          )}
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={onDisconnect}>
        {t("settings.repositories.disconnect")}
      </Button>
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

function ProviderSearchResults({
  accountId,
  query,
  onPick,
  linkingUrl,
}: {
  accountId: string | null;
  query: string;
  onPick: (repo: ProviderRepository) => void;
  linkingUrl: string | null;
}) {
  const t = useT();
  const debounced = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const search = useSearchProviderRepositories(accountId, debounced);

  if (accountId === null) {
    return (
      <p className="text-xs text-muted-foreground py-6 text-center">
        {t("settings.repositories.searchNoAccount")}
      </p>
    );
  }
  if (search.isPending) {
    return <Skeleton className="h-40 w-full" />;
  }
  if (search.isError) {
    return (
      <p className="text-xs text-destructive py-6 text-center">
        {errorMessage(search.error, t("settings.repositories.searchFailed"))}
      </p>
    );
  }
  const results = search.data ?? [];
  if (results.length === 0) {
    return (
      <p className="text-xs text-muted-foreground py-6 text-center">
        {t("settings.repositories.searchEmpty")}
      </p>
    );
  }
  return (
    <div className="max-h-64 overflow-y-auto rounded-lg border border-border/60">
      {results.map((repo) => (
        <button
          type="button"
          key={`${repo.ref.host}/${repo.ref.path}`}
          onClick={() => onPick(repo)}
          disabled={linkingUrl !== null}
          className="w-full flex items-start gap-3 px-3 py-2 text-left border-b border-border/60 last:border-b-0 hover:bg-muted/60 disabled:opacity-60"
        >
          <ProviderIcon provider={repo.ref.provider} />
          <div className="min-w-0 flex-1">
            <span className="text-sm truncate block">{repo.ref.path}</span>
            {repo.description && (
              <span className="text-xs text-muted-foreground truncate block">
                {repo.description}
              </span>
            )}
          </div>
          {linkingUrl === repo.webUrl && (
            <span className="text-xs text-muted-foreground shrink-0">
              {t("settings.repositories.linking")}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function AddRepositoryDialog({
  open,
  onOpenChange,
  accounts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: GitAccount[];
}) {
  const t = useT();
  const link = useLinkRepository();
  const [accountId, setAccountId] = useState<string | null>(
    accounts[0]?.id ?? null,
  );
  const [urlAccountId, setUrlAccountId] = useState<string>(NO_ACCOUNT);
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [linkingUrl, setLinkingUrl] = useState<string | null>(null);

  function submit(input: { url: string; accountId?: string }) {
    setLinkingUrl(input.url);
    link.mutate(input, {
      onSuccess: (repository) => {
        toast.success(
          t("settings.repositories.linked", { path: repository.path }),
        );
        setUrl("");
        onOpenChange(false);
      },
      onError: (err) =>
        toast.error(errorMessage(err, t("settings.repositories.failed"))),
      onSettled: () => setLinkingUrl(null),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("settings.repositories.addDialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("settings.repositories.addDialogDescription")}
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="search">
          <TabsList>
            <TabsTrigger value="search">
              {t("settings.repositories.tabSearch")}
            </TabsTrigger>
            <TabsTrigger value="url">
              {t("settings.repositories.tabUrl")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="search" className="flex flex-col gap-3 pt-3">
            <Select
              value={accountId ?? undefined}
              onValueChange={(value) => setAccountId(value)}
            >
              <SelectTrigger
                aria-label={t("settings.repositories.accountLabel")}
              >
                <SelectValue
                  placeholder={t("settings.repositories.accountPlaceholder")}
                />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.login} · {account.host}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("settings.repositories.searchPlaceholder")}
            />
            <ProviderSearchResults
              accountId={accountId}
              query={query}
              linkingUrl={linkingUrl}
              onPick={(repo) =>
                submit({
                  url: repo.webUrl,
                  ...(accountId ? { accountId } : {}),
                })
              }
            />
          </TabsContent>
          <TabsContent value="url" className="flex flex-col gap-3 pt-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="repository-url">
                {t("settings.repositories.urlLabel")}
              </Label>
              <Input
                id="repository-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={t("settings.repositories.urlPlaceholder")}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="repository-url-account">
                {t("settings.repositories.accountLabel")}
              </Label>
              <Select value={urlAccountId} onValueChange={setUrlAccountId}>
                <SelectTrigger id="repository-url-account">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_ACCOUNT}>
                    {t("settings.repositories.accountNone")}
                  </SelectItem>
                  {accounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.login} · {account.host}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={link.isPending}
              >
                {t("settings.repositories.cancel")}
              </Button>
              <Button
                disabled={!url.trim() || link.isPending}
                onClick={() =>
                  submit({
                    url: url.trim(),
                    ...(urlAccountId === NO_ACCOUNT
                      ? {}
                      : { accountId: urlAccountId }),
                  })
                }
              >
                {link.isPending
                  ? t("settings.repositories.linking")
                  : t("settings.repositories.link")}
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
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
  const github = capabilities.data?.github;
  const gitlab = capabilities.data?.gitlab;

  const githubConfigured = github?.configured === true;
  const gitlabConfigured = (gitlab?.oauthHosts.length ?? 0) > 0;

  if (capabilities.isPending) {
    return <Skeleton className="h-9 w-40" />;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {githubConfigured && github?.connectPath && (
        <Button size="sm" asChild>
          <a href={github.connectPath}>
            <GitHubIcon size={14} />
            {t("settings.repositories.connectGithub")}
          </a>
        </Button>
      )}
      {githubConfigured && hasGithubAccount && github?.installPath && (
        <Button size="sm" variant="outline" asChild>
          <a href={github.installPath}>
            {t("settings.repositories.installGithub")}
          </a>
        </Button>
      )}
      {gitlabConfigured && gitlab?.connectPath && (
        <Button size="sm" variant="outline" asChild>
          <a href={gitlab.connectPath}>
            <GitLabIcon size={14} />
            {t("settings.repositories.connectGitlab")}
          </a>
        </Button>
      )}
      <Button size="sm" variant="outline" onClick={onTokenDialog}>
        {t("settings.repositories.connectGitlabToken")}
      </Button>
    </div>
  );
}

function AccountsSection({
  onTokenDialog,
  onDisconnect,
}: {
  onTokenDialog: () => void;
  onDisconnect: (account: GitAccount) => void;
}) {
  const t = useT();
  const capabilities = useGitProviderCapabilities();
  const accounts = useGitAccounts();

  const githubConfigured = capabilities.data?.github.configured === true;
  const gitlabConfigured =
    (capabilities.data?.gitlab.oauthHosts.length ?? 0) > 0;
  const anyProviderConfigured = githubConfigured || gitlabConfigured;
  const rows = accounts.data ?? [];

  return (
    <SettingsSection
      title={t("settings.repositories.accountsTitle")}
      description={t("settings.repositories.accountsDescription")}
      actions={
        rows.length > 0 ? (
          <ConnectActions
            onTokenDialog={onTokenDialog}
            hasGithubAccount={rows.some((a) => a.type === "github")}
          />
        ) : null
      }
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
          <Button size="sm" variant="outline" onClick={onTokenDialog}>
            <GitLabIcon size={14} />
            {t("settings.repositories.connectGitlabToken")}
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <div
          data-testid="git-accounts-list"
          className="rounded-2xl border border-dashed border-border/60 p-10 flex flex-col items-center justify-center text-center gap-3"
        >
          <div className="size-12 rounded-full bg-muted flex items-center justify-center">
            <GitHubIcon size={20} className="text-muted-foreground" />
          </div>
          <div>
            <p className="font-medium text-sm">
              {t("settings.repositories.accountsEmptyTitle")}
            </p>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm">
              {t("settings.repositories.accountsEmptyDescription")}
            </p>
          </div>
          <ConnectActions
            onTokenDialog={onTokenDialog}
            hasGithubAccount={false}
          />
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
  accounts,
  onAdd,
  onUnlink,
}: {
  accounts: GitAccount[];
  onAdd: () => void;
  onUnlink: (repository: Repository) => void;
}) {
  const t = useT();
  const repositories = useRepositories();
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
          <Button size="sm" onClick={onAdd} disabled={accounts.length === 0}>
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

function RepositoriesContent() {
  const t = useT();
  const accounts = useGitAccounts();
  const deleteAccount = useDeleteGitAccount();
  const deleteRepository = useDeleteRepository();

  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
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

      <AccountsSection
        onTokenDialog={() => setTokenDialogOpen(true)}
        onDisconnect={setPendingAccount}
      />

      <RepositoriesSection
        accounts={accounts.data ?? []}
        onAdd={() => setAddOpen(true)}
        onUnlink={setPendingRepository}
      />

      <TokenConnectDialog
        open={tokenDialogOpen}
        onOpenChange={setTokenDialogOpen}
      />

      {addOpen && (
        <AddRepositoryDialog
          open
          onOpenChange={setAddOpen}
          accounts={accounts.data ?? []}
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
    <SettingsGroupPage group="storage">
      <RepositoriesContent />
    </SettingsGroupPage>
  );
}
