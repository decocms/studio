/**
 * Pick a repository from the org's connected git accounts.
 *
 * The counterpart of `GitHubRepoPicker` for the first-class repository model:
 * instead of listing GitHub App installations and provisioning a repo-scoped
 * `mcp-github` connection per repo, it lists the org's git provider accounts
 * (GitHub or GitLab) and links the chosen repository with `REPOSITORY_LINK`.
 * Already-linked repositories are offered first, so picking one costs no
 * provider call at all.
 *
 * `GitHubRepoPicker` renders this whenever the org has a serviceable account;
 * orgs still on the legacy connection keep the old flow untouched.
 */

import { useDeferredValue, useState } from "react";
import { ArrowLeft, SearchLg } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { CollectionSearch } from "@/components/collections/collection-search";
import { GitHubIcon } from "@/components/icons/github-icon";
import { GitLabIcon } from "@/components/icons/gitlab-icon";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  type GitAccount,
  type Repository,
  useGitAccounts,
  useLinkRepository,
  useRepositories,
  useSearchProviderRepositories,
} from "@/hooks/use-git-providers";
import { useT } from "@/i18n/use-t.ts";

/** What a caller gets back: always a linked repository row. */
export interface RepositoryPickPayload {
  repository: Repository;
}

function ProviderIcon({
  provider,
  className,
}: {
  provider: "github" | "gitlab";
  className?: string;
}) {
  return provider === "gitlab" ? (
    <GitLabIcon size={16} className={className} />
  ) : (
    <GitHubIcon size={16} className={className} />
  );
}

/** An account Studio can actually mint credentials for. */
export function serviceableAccounts(
  accounts: GitAccount[] | undefined,
): GitAccount[] {
  return (accounts ?? []).filter((a) => a.status === "active" && a.servable);
}

function RepoRow({
  provider,
  path,
  host,
  hint,
  disabled,
  busy,
  onSelect,
}: {
  provider: "github" | "gitlab";
  path: string;
  host: string;
  hint?: string | null;
  disabled: boolean;
  busy: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/60 transition-colors",
        disabled && "opacity-60 cursor-not-allowed",
      )}
    >
      <ProviderIcon provider={provider} className="text-muted-foreground" />
      <span className="flex-1 min-w-0">
        <span className="block text-sm truncate">{path}</span>
        <span className="block text-xs text-muted-foreground truncate">
          {hint ? `${host} · ${hint}` : host}
        </span>
      </span>
      {busy ? <Spinner className="size-4 text-muted-foreground" /> : null}
    </button>
  );
}

function LinkedRepositories({
  onPick,
  pendingPath,
}: {
  onPick: (repository: Repository) => void;
  pendingPath: string | null;
}) {
  const t = useT();
  const repositories = useRepositories();
  if (repositories.isPending) return <Skeleton className="h-24 w-full" />;
  const rows = repositories.data ?? [];
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="px-4 py-2 text-xs font-medium text-muted-foreground">
        {t("common.repositoryPicker.linkedSection")}
      </p>
      {rows.map((repo) => (
        <RepoRow
          key={repo.id}
          provider={repo.provider}
          path={repo.path}
          host={repo.host}
          hint={repo.defaultBranch}
          disabled={pendingPath !== null}
          busy={pendingPath === repo.path}
          onSelect={() => onPick(repo)}
        />
      ))}
    </div>
  );
}

function ProviderSearch({
  account,
  onLink,
  pendingPath,
}: {
  account: GitAccount;
  onLink: (webUrl: string, path: string) => void;
  pendingPath: string | null;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query, 300);
  const deferred = useDeferredValue(debounced);
  const isStale = query !== deferred;
  const search = useSearchProviderRepositories(account.id, deferred);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <CollectionSearch
        placeholder={t("common.repositoryPicker.searchPlaceholder")}
        value={query}
        onChange={setQuery}
        isSearching={isStale || search.isFetching}
      />
      <div
        className={cn(
          "flex-1 overflow-y-auto transition-opacity duration-150",
          isStale ? "opacity-40" : "opacity-100",
        )}
      >
        {search.isPending ? (
          <div className="flex-1 flex items-center justify-center py-10">
            <Spinner className="size-4.5 text-muted-foreground" />
          </div>
        ) : search.isError ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            {search.error instanceof Error
              ? search.error.message
              : t("common.repositoryPicker.searchFailed")}
          </p>
        ) : (search.data ?? []).length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            {t("common.repositoryPicker.searchEmpty")}
          </p>
        ) : (
          (search.data ?? []).map((repo) => (
            <RepoRow
              key={`${repo.ref.host}/${repo.ref.path}`}
              provider={repo.ref.provider}
              path={repo.ref.path}
              host={repo.ref.host}
              hint={repo.visibility}
              disabled={pendingPath !== null}
              busy={pendingPath === repo.ref.path}
              onSelect={() => onLink(repo.webUrl, repo.ref.path)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function AccountList({
  accounts,
  onSelect,
}: {
  accounts: GitAccount[];
  onSelect: (account: GitAccount) => void;
}) {
  const t = useT();
  return (
    <div className="flex-1 overflow-y-auto">
      <p className="px-4 py-2 text-xs font-medium text-muted-foreground">
        {t("common.repositoryPicker.browseSection")}
      </p>
      {accounts.map((account) => (
        <button
          key={account.id}
          type="button"
          onClick={() => onSelect(account)}
          className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/60 transition-colors"
        >
          <ProviderIcon
            provider={account.type}
            className="text-muted-foreground"
          />
          <span className="flex-1 min-w-0">
            <span className="block text-sm truncate">{account.login}</span>
            <span className="block text-xs text-muted-foreground truncate">
              {account.host}
            </span>
          </span>
          <SearchLg size={14} className="text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}

export function RepositoryPicker({
  open,
  onOpenChange,
  title,
  onPicked,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  onPicked: (payload: RepositoryPickPayload) => void;
  onError?: (message: string) => void;
}) {
  const t = useT();
  const accounts = useGitAccounts();
  const link = useLinkRepository();
  const [account, setAccount] = useState<GitAccount | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  const usable = serviceableAccounts(accounts.data);

  function pick(repository: Repository) {
    setPendingPath(repository.path);
    onPicked({ repository });
    setPendingPath(null);
  }

  function linkAndPick(webUrl: string, path: string) {
    if (!account) return;
    setPendingPath(path);
    link.mutate(
      { url: webUrl, accountId: account.id },
      {
        onSuccess: (repository) => onPicked({ repository }),
        onError: (err) =>
          onError?.(
            err instanceof Error
              ? err.message
              : t("common.repositoryPicker.linkFailed"),
          ),
        onSettled: () => setPendingPath(null),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setAccount(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[560px] h-[85svh] sm:h-[520px] p-0 gap-0 overflow-hidden flex flex-col">
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center h-12 border-b border-border px-4 gap-3 shrink-0">
          {account ? (
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setAccount(null)}
              aria-label={t("common.repositoryPicker.back")}
            >
              <ArrowLeft size={16} />
            </Button>
          ) : null}
          <span className="text-sm font-medium truncate">
            {account ? account.login : title}
          </span>
        </div>

        {accounts.isPending ? (
          <div className="p-4">
            <Skeleton className="h-24 w-full" />
          </div>
        ) : account ? (
          <ProviderSearch
            account={account}
            onLink={linkAndPick}
            pendingPath={pendingPath}
          />
        ) : (
          <div className="flex-1 overflow-y-auto">
            <LinkedRepositories onPick={pick} pendingPath={pendingPath} />
            {usable.length > 0 ? (
              <AccountList accounts={usable} onSelect={setAccount} />
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
