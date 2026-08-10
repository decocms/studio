import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { CollectionSearch } from "@/components/collections/collection-search.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Suspense, useDeferredValue, useState } from "react";
import { useDebouncedValue } from "@/hooks/use-debounced-value.ts";
import { useT } from "@/i18n/use-t.ts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  invalidateConnectionQueries,
  invalidateVirtualMcpQueries,
} from "@/lib/query-keys";
import {
  useProjectContext,
  useMCPClient,
  useConnections,
  useConnectionActions,
  SELF_MCP_ALIAS_ID,
} from "@/sdk";
import { Button } from "@decocms/ui/components/button.tsx";
import { authenticateAndPersistOAuth } from "@/lib/authenticate-and-persist-oauth";
import type { ConnectionEntity } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { toast } from "sonner";
import {
  ArrowLeft,
  LinkExternal01,
  Loading01,
  Lock01,
  LockUnlocked01,
} from "@untitledui/icons";
import { useAutoInstallGitHub } from "@/hooks/use-auto-install-github";
import { useNavigateToAgent } from "@/hooks/use-navigate-to-agent";
import { GitHubIcon } from "@/components/icons/github-icon";
import {
  fetchGithubInstallations,
  GITHUB_APP_INSTALL_URL,
} from "@/lib/github-installations";
import { getOrgGithubConnections } from "@decocms/shared/github-repo-scope";
import { provisionRepoScopedGithubConnection } from "@/lib/provision-repo-scoped-github-connection";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";

export interface GitHubInstallation {
  installationId: number;
  login: string;
  avatarUrl: string;
  type: string;
}

export interface Repo {
  owner: string;
  name: string;
  fullName: string;
  url: string;
  private: boolean;
  description: string | null;
  updatedAt: string;
  fork: boolean;
}

export interface GitHubImportPayload {
  virtualMcpId: string;
  repo: Repo;
  connectionId: string;
}

export function GitHubRepoPicker({
  open,
  onOpenChange,
  title,
  onImportComplete,
  mode = "agent",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  onImportComplete?: (payload: GitHubImportPayload) => void;
  /**
   * "agent" (default): pick a repo → provision a repo-scoped connection + a new
   * agent bound to it. "connection": provision an org-shared repo connection
   * only (available to every agent), no agent.
   */
  mode?: "agent" | "connection";
}) {
  const t = useT();
  const resolvedTitle =
    title ??
    (mode === "connection"
      ? t("common.githubRepoPicker.addRepo")
      : t("common.githubRepoPicker.importFromGitHub"));
  const [selectedInstallation, setSelectedInstallation] =
    useState<GitHubInstallation | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px] h-[85svh] sm:h-[520px] p-0 gap-0 overflow-hidden flex flex-col">
        <DialogHeader className="sr-only">
          <DialogTitle>{resolvedTitle}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center h-12 border-b border-border px-4 gap-3 shrink-0">
          {selectedInstallation ? (
            <>
              <button
                type="button"
                onClick={() => setSelectedInstallation(null)}
                className="flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors shrink-0"
                aria-label={t("common.githubRepoPicker.backToAccounts")}
              >
                <ArrowLeft size={16} />
              </button>
              <img
                src={selectedInstallation.avatarUrl}
                alt={selectedInstallation.login}
                className="size-5 rounded-full ring-1 ring-border shrink-0"
              />
              <span className="text-sm font-medium text-foreground">
                {selectedInstallation.login}
              </span>
            </>
          ) : (
            <>
              <GitHubIcon className="size-4 text-foreground shrink-0" />
              <span className="text-sm font-medium text-foreground">
                {resolvedTitle}
              </span>
            </>
          )}
        </div>
        <div className="flex-1 overflow-hidden flex flex-col min-w-0">
          <Suspense
            fallback={
              <div className="flex-1 flex items-center justify-center">
                <Loading01
                  size={18}
                  className="animate-spin text-muted-foreground"
                />
              </div>
            }
          >
            <PickerContent
              open={open}
              onComplete={() => onOpenChange(false)}
              selectedInstallation={selectedInstallation}
              onSelectInstallation={setSelectedInstallation}
              onImportComplete={onImportComplete}
              mode={mode}
            />
          </Suspense>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PickerContent({
  open,
  onComplete,
  selectedInstallation,
  onSelectInstallation,
  onImportComplete,
  mode = "agent",
}: {
  open: boolean;
  onComplete: () => void;
  selectedInstallation: GitHubInstallation | null;
  onSelectInstallation: (inst: GitHubInstallation | null) => void;
  onImportComplete?: (payload: GitHubImportPayload) => void;
  mode?: "agent" | "connection";
}) {
  const t = useT();
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const navigateToAgent = useNavigateToAgent();
  const [selectedConnection, setSelectedConnection] =
    useState<ConnectionEntity | null>(null);

  const allGithubConnections = useConnections({ slug: "mcp-github" });
  const orgGithubConnections = getOrgGithubConnections(allGithubConnections);

  const autoInstall = useAutoInstallGitHub({
    enabled: open && orgGithubConnections.length === 0,
  });

  const effectiveConnection =
    orgGithubConnections.length === 1
      ? (orgGithubConnections[0] ?? null)
      : selectedConnection;

  const githubClient = useMCPClient({
    connectionId: effectiveConnection?.id ?? "",
    orgId: org.id,
    orgSlug: org.slug,
  });
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const getFileContent = async (
    repo: Repo,
    path: string,
  ): Promise<string | null> => {
    try {
      const result = await githubClient.callTool({
        name: "get_file_contents",
        arguments: { owner: repo.owner, repo: repo.name, path },
      });
      const typed = result as {
        isError?: boolean;
        content?: Array<{
          type?: string;
          text?: string;
          resource?: { text?: string };
        }>;
      };
      if (typed.isError) return null;
      const resourceBlock = typed.content?.find((c) => c.type === "resource");
      const content = resourceBlock?.resource?.text;
      if (!content) return null;
      try {
        const parsed = JSON.parse(content);
        return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      } catch {
        return content;
      }
    } catch {
      return null;
    }
  };

  // Runtime detection moved server-side into SANDBOX_START (see
  // github-runtime-detect.ts). Here we only pull AGENTS.md / CLAUDE.md so the
  // agent has instructions ready even before the first sandbox boots.
  const detectRepoFiles = (virtualMcpId: string, repo: Repo) => {
    Promise.all([
      getFileContent(repo, "AGENTS.md"),
      getFileContent(repo, "CLAUDE.md"),
    ])
      .then(async ([agents, claude]) => {
        const instructions = agents ?? claude ?? null;
        if (!instructions) return;
        await selfClient.callTool({
          name: "COLLECTION_VIRTUAL_MCP_UPDATE",
          arguments: {
            id: virtualMcpId,
            data: { metadata: { instructions } },
          },
        });
        invalidateVirtualMcpQueries(queryClient, org.id);
      })
      .catch((err) => {
        console.error("GitHub instructions fetch failed:", err);
      });
  };

  const importMutation = useMutation({
    mutationFn: async (repo: Repo) => {
      if (!effectiveConnection || !selectedInstallation) {
        throw new Error("No GitHub connection or installation");
      }

      const installationId = selectedInstallation.installationId;

      // Connection-only ("Add repo"): provision an org-shared repo connection
      // that every agent can use, then stop — no agent, no automations.
      if (mode === "connection") {
        const { childConnectionId } = await provisionRepoScopedGithubConnection(
          {
            orgSlug: org.slug,
            sourceConnection: effectiveConnection,
            installationId,
            owner: repo.owner,
            repo: repo.name,
            githubCallTool: (req) => githubClient.callTool(req),
            selfCallTool: (req) => selfClient.callTool(req),
            orgShared: true,
          },
        );
        return {
          virtualMcpId: null,
          repo,
          connectionId: childConnectionId,
          item: null,
        };
      }

      const { childConnectionId, reused } =
        await provisionRepoScopedGithubConnection({
          orgSlug: org.slug,
          sourceConnection: effectiveConnection,
          installationId,
          owner: repo.owner,
          repo: repo.name,
          githubCallTool: (req) => githubClient.callTool(req),
          selfCallTool: (req) => selfClient.callTool(req),
        });

      let createdAgentId: string | null = null;

      try {
        // Create the agent wired to the CHILD connection (not the org one).
        const result = (await selfClient.callTool({
          name: "COLLECTION_VIRTUAL_MCP_CREATE",
          arguments: {
            data: {
              title: repo.name,
              description: repo.description || "Imported from GitHub",
              pinned: false,
              icon: null,
              metadata: {
                githubRepo: {
                  owner: repo.owner,
                  name: repo.name,
                  url: repo.url,
                  installationId,
                  connectionId: childConnectionId,
                },
                instructions: null,
                // runtime is resolved server-side inside SANDBOX_START's
                // lockfile probe (github-runtime-detect.ts). Writing a
                // client-side sentinel here only re-created the race the probe
                // fixed.
                ui: {
                  pinnedViews: null,
                  layout: {
                    defaultMainView: { type: "preview" },
                    chatDefaultOpen: true,
                  },
                },
              },
              connections: [{ connection_id: childConnectionId }],
            },
          },
        })) as { structuredContent?: unknown };

        const payload = (result.structuredContent ?? result) as {
          item?: { id: string; title: string };
        };
        const virtualMcpId = payload.item?.id;
        if (!payload.item || !virtualMcpId) {
          throw new Error("Failed to create the imported agent");
        }
        createdAgentId = virtualMcpId;

        return {
          virtualMcpId,
          repo,
          connectionId: childConnectionId,
          item: payload.item,
        };
      } catch (err) {
        // Rollback: leave nothing behind THAT WE CREATED. If the agent was
        // created, delete it (which also tears down its repo-scoped child via
        // server-side cleanup); then the child, as belt-and-suspenders.
        //
        // A reused connection predates this import and other agents may hold
        // it — rolling it back would revoke a repo the org still uses.
        if (createdAgentId) {
          await selfClient
            .callTool({
              name: "COLLECTION_VIRTUAL_MCP_DELETE",
              arguments: { id: createdAgentId },
            })
            .catch(() => {});
        }
        if (!reused) {
          await selfClient
            .callTool({
              name: "COLLECTION_CONNECTIONS_DELETE",
              arguments: { id: childConnectionId, force: true },
            })
            .catch(() => {});
        }
        throw err;
      }
    },
    onSuccess: ({ virtualMcpId, repo, connectionId, item }) => {
      if (mode === "connection" || !virtualMcpId || !item) {
        invalidateVirtualMcpQueries(queryClient, org.id);
        invalidateConnectionQueries(queryClient, org.id);
        toast.success(
          t("common.githubRepoPicker.addedRepo", { name: repo.name }),
        );
        onComplete();
        return;
      }
      queryClient.setQueryData(
        KEYS.collectionItem(
          selfClient,
          org.id,
          "",
          "VIRTUAL_MCP",
          virtualMcpId,
        ),
        { item },
      );
      invalidateVirtualMcpQueries(queryClient, org.id);

      detectRepoFiles(virtualMcpId, repo);

      if (onImportComplete) {
        onImportComplete({ virtualMcpId, repo, connectionId });
        return;
      }

      toast.success(
        t("common.githubRepoPicker.importedRepo", { name: repo.name }),
      );
      onComplete();
      localStorage.setItem(
        LOCALSTORAGE_KEYS.sidebarOpen(),
        JSON.stringify(false),
      );
      navigateToAgent(virtualMcpId);
    },
    onError: (error, repo) => {
      console.error("GitHub import failed:", error);
      const message =
        error instanceof Error
          ? error.message
          : t("common.githubRepoPicker.unknownError");
      // A fork the GitHub App wasn't granted shows up in public search but the
      // token mint fails (provisionRepoScopedGithubConnection throws a
      // "…mint a repo-scoped GitHub token…" error) — point the user at the
      // installation settings. Only do this for the mint failure; other fork
      // import errors (agent create, rollback, network) keep the real message.
      if (repo.fork && message.toLowerCase().includes("mint")) {
        toast.error(
          t("common.githubRepoPicker.failedImportFork", { name: repo.name }),
        );
        return;
      }
      toast.error(
        t("common.githubRepoPicker.failedImport", { error: message }),
      );
    },
  });

  if (
    autoInstall.status === "installing" ||
    autoInstall.status === "authenticating"
  ) {
    return (
      <AutoInstallGitHubUI
        status={autoInstall.status}
        error={null}
        retry={autoInstall.retry}
      />
    );
  }

  if (autoInstall.status === "error") {
    return (
      <AutoInstallGitHubUI
        status="error"
        error={autoInstall.error}
        retry={autoInstall.retry}
      />
    );
  }

  if (orgGithubConnections.length === 0 && autoInstall.status === "idle") {
    return (
      <AutoInstallGitHubUI
        status="installing"
        error={null}
        retry={autoInstall.retry}
      />
    );
  }

  if (orgGithubConnections.length > 1 && !effectiveConnection) {
    return (
      <div className="flex flex-col py-2">
        <div className="px-4 py-2">
          <p className="text-xs font-medium text-muted-foreground">
            {t("common.githubRepoPicker.selectConnection")}
          </p>
        </div>
        {orgGithubConnections.map((conn) => (
          <button
            key={conn.id}
            type="button"
            onClick={() => setSelectedConnection(conn)}
            className="flex items-center gap-3 px-4 py-3 hover:bg-accent transition-colors text-left"
          >
            {conn.icon ? (
              <img
                src={conn.icon}
                alt={conn.title}
                className="size-7 rounded-full shrink-0"
              />
            ) : (
              <div className="size-7 rounded-full bg-muted flex items-center justify-center shrink-0">
                <GitHubIcon className="size-3.5 text-muted-foreground" />
              </div>
            )}
            <span className="text-sm font-medium">{conn.title}</span>
          </button>
        ))}
      </div>
    );
  }

  if (!effectiveConnection) return null;

  if (!selectedInstallation) {
    return (
      <InstallationPicker
        connectionId={effectiveConnection.id}
        orgId={org.id}
        orgSlug={org.slug}
        onSelect={onSelectInstallation}
        showBackButton={orgGithubConnections.length > 1}
        onBack={() => setSelectedConnection(null)}
      />
    );
  }

  return (
    <RepoBrowser
      connectionId={effectiveConnection.id}
      orgId={org.id}
      orgSlug={org.slug}
      installation={selectedInstallation}
      onSelectRepo={(repo) => importMutation.mutate(repo)}
      isSaving={importMutation.isPending}
    />
  );
}

function InstallationPicker({
  connectionId,
  orgId,
  orgSlug,
  onSelect,
  showBackButton,
  onBack,
}: {
  connectionId: string;
  orgId: string;
  orgSlug: string;
  onSelect: (installation: GitHubInstallation) => void;
  showBackButton: boolean;
  onBack: () => void;
}) {
  const t = useT();
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId,
    orgSlug,
  });
  const queryClient = useQueryClient();
  const connectionActions = useConnectionActions();

  const installationsQuery = useQuery({
    queryKey: KEYS.githubUserOrgs(orgId, connectionId),
    queryFn: () =>
      fetchGithubInstallations((req) => selfClient.callTool(req), connectionId),
  });

  // The load failure is usually an expired/revoked GitHub token. Re-run OAuth
  // for this connection (authenticateAndPersistOAuth no-ops when the token is
  // still valid, so it doubles as a plain retry), then refetch.
  const reconnect = useMutation({
    mutationFn: async () => {
      const auth = await authenticateAndPersistOAuth({
        connectionId,
        orgId,
        orgSlug,
        persistFallback: (token) =>
          connectionActions.update
            .mutateAsync({
              id: connectionId,
              data: { connection_token: token },
            })
            .then(() => undefined),
      });
      if (auth.ran && !auth.ok) {
        throw new Error(auth.error ?? "no token received");
      }
      const mcpProxyUrl = new URL(
        `/api/${orgSlug}/mcp/${connectionId}`,
        window.location.origin,
      );
      await queryClient.invalidateQueries({
        queryKey: KEYS.isMCPAuthenticated(mcpProxyUrl.href, null),
      });
      await queryClient.invalidateQueries({ queryKey: KEYS.mcpClientPrefix() });
      await installationsQuery.refetch();
    },
    onError: (err) => {
      toast.error(
        t("common.githubRepoPicker.failedReconnect", {
          error:
            err instanceof Error
              ? err.message
              : t("common.githubRepoPicker.unknownError"),
        }),
      );
    },
  });

  if (installationsQuery.isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loading01 size={18} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (installationsQuery.isError) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-destructive">
          {t("common.githubRepoPicker.failedLoadAccounts")}
        </p>
        <p className="text-xs text-muted-foreground max-w-[280px] leading-relaxed">
          {t("common.githubRepoPicker.connectionExpiredMessage")}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => reconnect.mutate()}
          disabled={reconnect.isPending}
        >
          {reconnect.isPending ? (
            <Loading01 size={14} className="animate-spin" />
          ) : (
            <GitHubIcon className="size-3.5" />
          )}
          {t("common.githubRepoPicker.reconnectGitHub")}
        </Button>
      </div>
    );
  }

  const data = installationsQuery.data;
  if (!data) return null;

  if (data.installations.length === 0) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        {showBackButton && (
          <div className="flex items-center gap-1 px-4 pt-3 pb-1 shrink-0">
            <button
              type="button"
              onClick={onBack}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft size={12} />
              {t("common.githubRepoPicker.changeConnection")}
            </button>
          </div>
        )}

        <div className="flex-1 flex flex-col items-center justify-center px-8 py-6 text-center">
          <div className="size-16 rounded-2xl bg-muted flex items-center justify-center">
            <GitHubIcon className="size-8 text-foreground" />
          </div>

          <div className="mt-4 flex items-center gap-1.5 text-xs font-medium text-success">
            <span className="size-1.5 rounded-full bg-success" />
            {t("common.githubRepoPicker.githubConnected")}
          </div>

          <h2 className="mt-2 text-base font-semibold text-foreground">
            {t("common.githubRepoPicker.setupRepositoriesTitle")}
          </h2>
          <p className="mt-1.5 max-w-[360px] text-xs leading-relaxed text-muted-foreground">
            {t("common.githubRepoPicker.noRepositoriesShared")}
          </p>

          <div className="mt-5 flex items-center gap-2">
            <Button asChild size="sm">
              <a
                href={GITHUB_APP_INSTALL_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("common.githubRepoPicker.chooseRepositories")}
                <LinkExternal01 size={14} />
              </a>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void installationsQuery.refetch()}
              disabled={installationsQuery.isFetching}
            >
              {installationsQuery.isFetching && (
                <Loading01 size={14} className="animate-spin" />
              )}
              {t("common.githubRepoPicker.checkAgain")}
            </Button>
          </div>

          <p className="mt-4 max-w-[360px] rounded-lg bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            {t("common.githubRepoPicker.repositoryAccessNote")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {showBackButton && (
        <div className="flex items-center gap-1 px-4 pt-3 pb-1 shrink-0">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft size={12} />
            {t("common.githubRepoPicker.changeConnection")}
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]">
        {data.installations.map((inst) => (
          <button
            key={inst.installationId}
            type="button"
            onClick={() => onSelect(inst)}
            className="w-full flex items-center gap-3 px-4 py-3 hover:bg-accent transition-colors text-left group"
          >
            <img
              src={inst.avatarUrl}
              alt={inst.login}
              className="size-7 rounded-full shrink-0 ring-1 ring-border"
            />
            <div className="flex flex-col min-w-0 flex-1">
              <span className="text-sm font-medium leading-none">
                {inst.login}
              </span>
              {inst.type === "User" && (
                <span className="text-xs text-muted-foreground mt-1">
                  {t("common.githubRepoPicker.personalAccount")}
                </span>
              )}
            </div>
            <span className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              {t("common.githubRepoPicker.select")} →
            </span>
          </button>
        ))}
      </div>

      <div className="px-4 py-3 border-t border-border shrink-0">
        <a
          href={GITHUB_APP_INSTALL_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {t("common.githubRepoPicker.accountNotListed")}{" "}
          <span className="underline underline-offset-2">
            {t("common.githubRepoPicker.installGitHubApp")}
          </span>
        </a>
      </div>
    </div>
  );
}

function RepoBrowser({
  connectionId,
  orgId,
  orgSlug,
  installation,
  onSelectRepo,
  isSaving,
}: {
  connectionId: string;
  orgId: string;
  orgSlug: string;
  installation: GitHubInstallation;
  onSelectRepo: (repo: Repo) => void;
  isSaving: boolean;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const deferredQuery = useDeferredValue(debouncedQuery);
  const isStale = query !== deferredQuery;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <CollectionSearch
        placeholder={t("common.githubRepoPicker.searchRepositories")}
        value={query}
        onChange={setQuery}
        isSearching={isStale}
      />

      <div
        className={cn(
          "flex-1 overflow-hidden flex flex-col transition-opacity duration-150",
          isStale ? "opacity-40" : "opacity-100",
        )}
      >
        <Suspense
          fallback={
            <div className="flex-1 flex items-center justify-center">
              <Loading01
                size={18}
                className="animate-spin text-muted-foreground"
              />
            </div>
          }
        >
          <RepoList
            connectionId={connectionId}
            orgId={orgId}
            orgSlug={orgSlug}
            installation={installation}
            query={deferredQuery}
            onSelectRepo={onSelectRepo}
            isSaving={isSaving}
          />
        </Suspense>
      </div>
    </div>
  );
}

function RepoList({
  connectionId,
  orgId,
  orgSlug,
  installation,
  query,
  onSelectRepo,
  isSaving,
}: {
  connectionId: string;
  orgId: string;
  orgSlug: string;
  installation: GitHubInstallation;
  query: string;
  onSelectRepo: (repo: Repo) => void;
  isSaving: boolean;
}) {
  const t = useT();
  const githubClient = useMCPClient({ connectionId, orgId, orgSlug });

  const qualifier = installation.type === "User" ? "user" : "org";
  // `fork:true` includes forks alongside non-forks. GitHub's search API omits
  // forks by default, so without this the picker silently hides every fork the
  // account owns. Forks the GitHub App wasn't granted still fail at import time
  // (see importMutation.onError) — that's surfaced with a fork-specific hint.
  const searchQuery = query
    ? `${qualifier}:${installation.login} ${query} in:name fork:true`
    : `${qualifier}:${installation.login} fork:true`;

  const { data: repos } = useSuspenseQuery({
    queryKey: KEYS.githubOrgRepos(
      orgId,
      connectionId,
      installation.login,
      query,
    ),
    queryFn: async ({ signal }) => {
      const result = await githubClient.callTool(
        {
          name: "search_repositories",
          arguments: { query: searchQuery, page: 1, perPage: 30 },
        },
        undefined,
        { signal },
      );
      const content = (result as { content?: Array<{ text?: string }> })
        .content?.[0]?.text;
      if (!content) throw new Error("No response from search_repositories");
      const parsed = JSON.parse(content) as {
        items?: Array<{
          name: string;
          full_name: string;
          html_url: string;
          private: boolean;
          description: string | null;
          updated_at: string;
          fork?: boolean;
        }>;
      };
      return (parsed.items ?? []).map((r) => ({
        name: r.name,
        fullName: r.full_name,
        owner: r.full_name.split("/")[0] ?? "",
        url: r.html_url,
        private: r.private,
        description: r.description,
        updatedAt: r.updated_at,
        fork: r.fork ?? false,
      }));
    },
  });

  if (repos.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-1">
        <p className="text-sm text-muted-foreground">
          {t("common.githubRepoPicker.noRepositoriesFound")}
        </p>
        {query && (
          <p className="text-xs text-muted-foreground/60">
            {t("common.githubRepoPicker.tryDifferentSearchTerm")}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col [scrollbar-gutter:stable]">
      {repos.map((repo) => (
        <button
          key={repo.fullName}
          type="button"
          onClick={() => onSelectRepo(repo)}
          disabled={isSaving}
          className="flex items-start gap-3 px-4 py-3 hover:bg-accent transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <GitHubIcon className="size-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <span className="text-sm font-medium truncate">{repo.name}</span>
            {repo.fork && (
              <span className="text-xs font-medium text-muted-foreground border border-border rounded px-1.5 py-0.5 shrink-0 leading-none">
                {t("common.githubRepoPicker.forkBadge")}
              </span>
            )}
          </div>
          <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground border border-border rounded px-1.5 py-0.5 shrink-0 leading-none">
            {repo.private ? <Lock01 size={10} /> : <LockUnlocked01 size={10} />}
            {repo.private
              ? t("common.githubRepoPicker.private")
              : t("common.githubRepoPicker.public")}
          </span>
        </button>
      ))}
    </div>
  );
}

function AutoInstallGitHubUI({
  status,
  error,
  retry,
}: {
  status: string;
  error: string | null;
  retry: () => void;
}) {
  const t = useT();
  if (status === "error") {
    return (
      <div className="flex flex-col items-center gap-4 px-6 py-10">
        <div className="size-10 rounded-full bg-destructive/10 flex items-center justify-center">
          <GitHubIcon className="size-5 text-destructive" />
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-sm font-medium">
            {t("common.githubRepoPicker.connectionFailed")}
          </p>
          <p className="text-xs text-muted-foreground max-w-[260px] leading-relaxed">
            {error ?? t("common.githubRepoPicker.somethingWentWrong")}
          </p>
        </div>
        <button
          type="button"
          onClick={retry}
          className="text-xs font-medium text-foreground border border-border rounded-md px-3 py-1.5 hover:bg-accent transition-colors"
        >
          {t("common.githubRepoPicker.tryAgain")}
        </button>
      </div>
    );
  }

  const isAuthenticating = status === "authenticating";

  return (
    <div className="flex flex-col items-center gap-4 px-6 py-10">
      <div className="relative size-10">
        <div className="size-10 rounded-full bg-muted flex items-center justify-center">
          <GitHubIcon className="size-5 text-foreground" />
        </div>
        <div className="absolute -bottom-0.5 -right-0.5 size-4 rounded-full bg-background flex items-center justify-center">
          <Loading01 size={12} className="animate-spin text-muted-foreground" />
        </div>
      </div>
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-sm font-medium">
          {isAuthenticating
            ? t("common.githubRepoPicker.authenticatingGitHub")
            : t("common.githubRepoPicker.settingUpGitHub")}
        </p>
        <p className="text-xs text-muted-foreground">
          {isAuthenticating
            ? t("common.githubRepoPicker.completeOAuthFlow")
            : t("common.githubRepoPicker.installingGitHubConnection")}
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "size-1.5 rounded-full",
            !isAuthenticating
              ? "bg-foreground animate-pulse"
              : "bg-muted-foreground/30",
          )}
        />
        <span
          className={cn(
            "size-1.5 rounded-full",
            isAuthenticating
              ? "bg-foreground animate-pulse"
              : "bg-muted-foreground/30",
          )}
        />
        <span className="size-1.5 rounded-full bg-muted-foreground/30" />
      </div>
    </div>
  );
}
