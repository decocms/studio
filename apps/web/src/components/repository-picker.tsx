import type { GitProviderKind } from "@decocms/shared/git-providers";
import type { SiteTemplateId } from "@decocms/shared/site-templates";
import { GitAccountConnect } from "@/components/git-account-connect";
import { useDeferredValue, useState } from "react";
import { ArrowLeft, ChevronRight, GitBranch01, Plus } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { CollectionSearch } from "@/components/collections/collection-search";
import {
  CreateSiteFlow,
  type CreateSiteRequest,
} from "@/components/create-site-flow";
import {
  GitAccountAvatar,
  GitAccountList,
  ProviderIcon,
  serviceableAccounts,
} from "@/components/git-account-list";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  type GitAccount,
  type Repository,
  useCreateRepositoryFromTemplate,
  useGitAccounts,
  useLinkRepository,
  useRepositories,
  useSearchProviderRepositories,
} from "@/hooks/use-git-providers";
import { useCreateSiteEnabled } from "@/hooks/use-organization-settings";
import { useT } from "@/i18n/use-t.ts";

/** What a caller gets back: always a linked repository row. */
export interface RepositoryPickPayload {
  repository: Repository;
  /** Set when the repository was just generated from a site template. */
  createdFromTemplate?: SiteTemplateId;
}

/** `pendingPath` while a site is being created, which has no path yet. */
const CREATE_SITE_PENDING = "create-site";

function RepoRow({
  provider,
  path,
  host,
  hint,
  disabled,
  busy,
  onSelect,
}: {
  provider: GitProviderKind;
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
        "w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-accent transition-colors focus-visible:outline-none focus-visible:bg-accent",
        disabled && "opacity-60 cursor-not-allowed",
      )}
    >
      <div className="size-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
        <ProviderIcon provider={provider} className="text-muted-foreground" />
      </div>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium truncate">{path}</span>
        <span className="block text-xs text-muted-foreground truncate">
          {hint ? `${host} · ${hint}` : host}
        </span>
      </span>
      {busy ? (
        <Spinner className="size-4 text-muted-foreground" />
      ) : (
        <ChevronRight size={16} className="shrink-0 text-muted-foreground" />
      )}
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
  const [query, setQuery] = useState("");
  if (repositories.isPending) return <Skeleton className="h-24 w-full" />;
  if (repositories.isError)
    return (
      <p role="alert" className="p-4 text-sm text-destructive">
        {repositories.error.message}
      </p>
    );
  const repositoriesList = repositories.data ?? [];
  if (repositoriesList.length === 0) return null;
  const rows = repositoriesList.filter((repo) =>
    repo.path.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <div className="pb-2">
      <CollectionSearch
        value={query}
        onChange={setQuery}
        placeholder={t("common.repositoryPicker.searchPlaceholder")}
        disabled={pendingPath !== null}
      />
      <p className="px-4 pt-4 pb-2 text-xs font-medium text-muted-foreground">
        {t("common.repositoryPicker.linkedSection")}
      </p>
      {rows.length === 0 && (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          {t("common.repositoryPicker.searchEmpty")}
        </p>
      )}
      {rows.map((repo) => (
        <RepoRow
          key={repo.id}
          provider={repo.provider}
          path={repo.path}
          host={repo.host}
          hint={repo.defaultBranch}
          disabled={pendingPath !== null}
          busy={pendingPath === repo.id}
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
  const results = search.data?.pages.flatMap((page) => page.repositories) ?? [];

  return (
    <div className="h-80 min-h-0 flex flex-col overflow-hidden">
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
        ) : results.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            {t(
              search.hasNextPage
                ? "common.repositoryPicker.searchMore"
                : "common.repositoryPicker.searchEmpty",
            )}
          </p>
        ) : (
          results.map((repo) => (
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
        {search.hasNextPage && (
          <Button
            variant="ghost"
            className="w-full"
            disabled={search.isFetchingNextPage || pendingPath !== null}
            onClick={() => void search.fetchNextPage()}
          >
            {t("common.repositoryPicker.loadMore")}
          </Button>
        )}
      </div>
    </div>
  );
}

export function RepositoryPicker({
  open,
  onOpenChange,
  title,
  onPicked,
  onError,
  allowCreateSite = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  onPicked: (payload: RepositoryPickPayload) => void | Promise<void>;
  onError?: (message: string) => void;
  /** Offer "Create a new site" (when the org has it enabled). */
  allowCreateSite?: boolean;
}) {
  const t = useT();
  const accounts = useGitAccounts();
  const link = useLinkRepository();
  const createRepository = useCreateRepositoryFromTemplate();
  const createSiteEnabled = useCreateSiteEnabled() && allowCreateSite;
  const [account, setAccount] = useState<GitAccount | null>(null);
  const [creatingSite, setCreatingSite] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const usable = serviceableAccounts(accounts.data);
  const githubAccounts = usable.filter((a) => a.type === "github");
  function reportError(err: unknown) {
    const message =
      err instanceof Error
        ? err.message
        : t("common.repositoryPicker.linkFailed");
    setError(message);
    onError?.(message);
  }

  async function pick(repository: Repository) {
    setPendingPath(repository.id);
    setError(null);
    try {
      await onPicked({ repository });
    } catch (err) {
      reportError(err);
    } finally {
      setPendingPath(null);
    }
  }

  async function linkAndPick(webUrl: string, path: string) {
    if (!account) return;
    setPendingPath(path);
    setError(null);
    try {
      const repository = await link.mutateAsync({
        url: webUrl,
        accountId: account.id,
      });
      await onPicked({ repository });
    } catch (err) {
      reportError(err);
    } finally {
      setPendingPath(null);
    }
  }

  async function createSiteAndPick({
    template,
    account: owner,
    name,
  }: CreateSiteRequest) {
    setPendingPath(CREATE_SITE_PENDING);
    setError(null);
    try {
      const repository = await createRepository.mutateAsync({
        accountId: owner.id,
        name,
        template,
      });
      await onPicked({ repository, createdFromTemplate: template });
    } catch (err) {
      reportError(err);
    } finally {
      setPendingPath(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pendingPath !== null) return;
        if (!next) {
          setAccount(null);
          setCreatingSite(false);
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg max-h-[85svh] p-0 gap-0 overflow-hidden flex flex-col">
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t("common.repositoryPicker.description")}
          </DialogDescription>
        </DialogHeader>
        {creatingSite ? (
          <CreateSiteFlow
            accounts={githubAccounts}
            pending={pendingPath !== null}
            onExit={() => {
              setCreatingSite(false);
              setError(null);
            }}
            onCreate={(request) => void createSiteAndPick(request)}
          />
        ) : (
          <>
            <div className="flex items-center h-12 border-b border-border px-4 pr-12 gap-3 shrink-0">
              {account ? (
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6 -ml-1"
                  disabled={pendingPath !== null}
                  onClick={() => setAccount(null)}
                  aria-label={t("common.repositoryPicker.back")}
                >
                  <ArrowLeft size={16} />
                </Button>
              ) : (
                <GitBranch01
                  size={16}
                  className="text-muted-foreground shrink-0"
                />
              )}
              {account && (
                <GitAccountAvatar account={account} className="size-6" />
              )}
              <span className="text-sm font-medium truncate">
                {account ? account.login : title}
              </span>
            </div>

            {accounts.isPending ? (
              <div className="p-4">
                <Skeleton className="h-24 w-full" />
              </div>
            ) : accounts.isError ? (
              <p role="alert" className="p-4 text-sm text-destructive">
                {accounts.error.message}
              </p>
            ) : account ? (
              <ProviderSearch
                key={account.id}
                account={account}
                onLink={(url, path) => void linkAndPick(url, path)}
                pendingPath={pendingPath}
              />
            ) : (
              <div className="flex-1 overflow-y-auto">
                {createSiteEnabled && (
                  <div className="border-b border-border py-2">
                    <button
                      type="button"
                      disabled={pendingPath !== null}
                      onClick={() => {
                        setCreatingSite(true);
                        setError(null);
                      }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-accent transition-colors focus-visible:outline-none focus-visible:bg-accent disabled:opacity-50"
                    >
                      <div className="size-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                        <Plus size={16} className="text-muted-foreground" />
                      </div>
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium truncate">
                          {t("common.createSite.entry")}
                        </span>
                        <span className="block text-xs text-muted-foreground truncate">
                          {t("common.createSite.entryHint")}
                        </span>
                      </span>
                      <ChevronRight
                        size={16}
                        className="shrink-0 text-muted-foreground"
                      />
                    </button>
                  </div>
                )}
                <LinkedRepositories onPick={pick} pendingPath={pendingPath} />
                {usable.length > 0 && (
                  <GitAccountList
                    title={t("common.repositoryPicker.browseSection")}
                    accounts={usable}
                    onSelect={setAccount}
                    disabled={pendingPath !== null}
                  />
                )}
                <div className="border-t border-border py-2">
                  <p className="px-4 py-2 text-xs text-muted-foreground leading-relaxed">
                    {t("common.repositoryPicker.description")}
                  </p>
                  <GitAccountConnect
                    layout="picker"
                    disabled={pendingPath !== null}
                  />
                </div>
              </div>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="px-4 pb-3 text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
