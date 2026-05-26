import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Checkbox } from "@deco/ui/components/checkbox.tsx";
import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Suspense, useDeferredValue, useState } from "react";
import { useDebouncedValue } from "@/web/hooks/use-debounced-value.ts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { invalidateVirtualMcpQueries } from "@/web/lib/query-keys";
import {
  useProjectContext,
  useMCPClient,
  useConnectionActions,
  SELF_MCP_ALIAS_ID,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import { toast } from "sonner";
import {
  ArrowLeft,
  Loading01,
  Lock01,
  LockUnlocked01,
} from "@untitledui/icons";
import { useGithubImportConnection } from "@/web/hooks/use-auto-install-github";
import { useNavigateToAgent } from "@/web/hooks/use-navigate-to-agent";
import { GitHubIcon } from "@/web/components/icons/github-icon";
import {
  STOREFRONT_GITHUB_AUTOMATIONS,
  setupStorefrontGithubAutomations,
} from "@/tools/virtual/storefront-github-automations";
import { githubConnectionTitle } from "@/shared/github-connection";
import { scopeGithubConnectionToRepository } from "@/web/lib/github-oauth";

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
  repositoryId: number;
}

export interface GitHubImportPayload {
  virtualMcpId: string;
  repo: Repo;
  connectionId: string;
}

export function GitHubRepoPicker({
  open,
  onOpenChange,
  title = "Import from GitHub",
  hideAutoRespondCheckbox = false,
  onImportComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  hideAutoRespondCheckbox?: boolean;
  onImportComplete?: (payload: GitHubImportPayload) => void;
}) {
  const [selectedInstallation, setSelectedInstallation] =
    useState<GitHubInstallation | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px] h-[85svh] sm:h-[520px] p-0 gap-0 overflow-hidden flex flex-col">
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center h-12 border-b border-border px-4 gap-3 shrink-0">
          {selectedInstallation ? (
            <>
              <button
                type="button"
                onClick={() => setSelectedInstallation(null)}
                className="flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors shrink-0"
                aria-label="Back to accounts"
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
                {title}
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
              onComplete={() => onOpenChange(false)}
              selectedInstallation={selectedInstallation}
              onSelectInstallation={setSelectedInstallation}
              hideAutoRespondCheckbox={hideAutoRespondCheckbox}
              onImportComplete={onImportComplete}
            />
          </Suspense>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PickerContent({
  onComplete,
  selectedInstallation,
  onSelectInstallation,
  hideAutoRespondCheckbox,
  onImportComplete,
}: {
  onComplete: () => void;
  selectedInstallation: GitHubInstallation | null;
  onSelectInstallation: (inst: GitHubInstallation | null) => void;
  hideAutoRespondCheckbox?: boolean;
  onImportComplete?: (payload: GitHubImportPayload) => void;
}) {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const navigateToAgent = useNavigateToAgent();
  const connectionActions = useConnectionActions();
  const [autoRespondEnabled, setAutoRespondEnabled] = useState(true);
  const [selectedAutomationKeys, setSelectedAutomationKeys] = useState<
    Set<string>
  >(
    () =>
      new Set(
        STOREFRONT_GITHUB_AUTOMATIONS.filter((s) => s.defaultEnabled).map(
          (s) => s.key,
        ),
      ),
  );
  const defaultEnabledKeys = STOREFRONT_GITHUB_AUTOMATIONS.filter(
    (s) => s.defaultEnabled,
  ).map((s) => s.key);
  const effectiveSelectedKeys = hideAutoRespondCheckbox
    ? new Set(defaultEnabledKeys)
    : autoRespondEnabled
      ? selectedAutomationKeys
      : new Set<string>();

  const importSession = useGithubImportConnection({
    enabled: true,
  });

  const effectiveConnection = importSession.connection;

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

  const setupGithubAutomations = async ({
    virtualMcpId,
    repo,
    connectionId,
    selectedKeys,
  }: {
    virtualMcpId: string;
    repo: Repo;
    connectionId: string;
    selectedKeys: Set<string>;
  }) => {
    const { total, failed } = await setupStorefrontGithubAutomations({
      githubCallTool: (req) => githubClient.callTool(req),
      selfCallTool: (req) => selfClient.callTool(req),
      virtualMcpId,
      repo,
      connectionId,
      selectedKeys,
    });
    if (failed > 0) {
      toast.warning(
        `Set up ${total - failed}/${total} GitHub automations. Add the rest from the automations view.`,
      );
    }
  };

  const importMutation = useMutation({
    mutationFn: async (repo: Repo) => {
      if (!effectiveConnection || !selectedInstallation) {
        throw new Error("No GitHub connection or installation");
      }

      const connectionId = effectiveConnection.id;

      await scopeGithubConnectionToRepository({
        githubClient: githubClient as unknown as Parameters<
          typeof scopeGithubConnectionToRepository
        >[0]["githubClient"],
        orgSlug: org.slug,
        connectionId,
        repositoryId: repo.repositoryId,
        target: repo.owner,
        existingTokenInfo: importSession.tokenInfo ?? undefined,
      });

      await connectionActions.update.mutateAsync({
        id: connectionId,
        data: {
          title: githubConnectionTitle(repo.owner, repo.name),
          metadata: {
            githubRepo: {
              owner: repo.owner,
              name: repo.name,
              url: repo.url,
              repositoryId: repo.repositoryId,
              installationId: selectedInstallation.installationId,
            },
          },
        },
      });

      const result = (await selfClient.callTool({
        name: "COLLECTION_VIRTUAL_MCP_CREATE",
        arguments: {
          data: {
            title: repo.name,
            description: repo.description || "Imported from GitHub",
            pinned: true,
            icon: null,
            metadata: {
              githubRepo: {
                owner: repo.owner,
                name: repo.name,
                url: repo.url,
                repositoryId: repo.repositoryId,
                installationId: selectedInstallation.installationId,
                connectionId,
              },
              instructions: null,
              // runtime is resolved server-side inside SANDBOX_START's lockfile
              // probe (github-runtime-detect.ts). Writing a client-side
              // sentinel here only re-created the race the probe fixed.
              ui: {
                pinnedViews: null,
                layout: {
                  defaultMainView: {
                    type: "preview",
                  },
                  chatDefaultOpen: true,
                },
              },
            },
            connections: [{ connection_id: connectionId }],
          },
        },
      })) as { structuredContent?: unknown };

      const payload = (result.structuredContent ?? result) as {
        item: { id: string; title: string };
      };

      const virtualMcpId = payload.item.id;

      if (effectiveSelectedKeys.size > 0) {
        await setupGithubAutomations({
          virtualMcpId,
          repo,
          connectionId,
          selectedKeys: effectiveSelectedKeys,
        }).catch((err) => {
          console.error("Failed to set up GitHub automations:", err);
          toast.warning(
            "Imported repo, but failed to set up GitHub automations. You can add triggers manually from the automations view.",
          );
        });
      }

      return {
        virtualMcpId,
        repo,
        connectionId,
        item: payload.item,
      };
    },
    onSuccess: ({ virtualMcpId, repo, connectionId, item }) => {
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

      toast.success(`Imported ${repo.name} from GitHub`);
      onComplete();
      localStorage.setItem("mesh:sidebar-open", JSON.stringify(false));
      navigateToAgent(virtualMcpId);
    },
    onError: (error) => {
      toast.error(
        "Failed to import repo: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    },
  });

  if (
    importSession.status === "installing" ||
    importSession.status === "authenticating"
  ) {
    return (
      <AutoInstallGitHubUI
        status={importSession.status}
        error={null}
        retry={importSession.retry}
      />
    );
  }

  if (importSession.status === "error") {
    return (
      <AutoInstallGitHubUI
        status="error"
        error={importSession.error}
        retry={importSession.retry}
      />
    );
  }

  if (!effectiveConnection && importSession.status === "idle") {
    return (
      <AutoInstallGitHubUI
        status="installing"
        error={null}
        retry={importSession.retry}
      />
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
        showBackButton={false}
        onBack={() => onSelectInstallation(null)}
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
      autoRespondEnabled={autoRespondEnabled}
      onAutoRespondChange={setAutoRespondEnabled}
      selectedAutomationKeys={selectedAutomationKeys}
      onAutomationKeysChange={setSelectedAutomationKeys}
      hideAutoRespondCheckbox={hideAutoRespondCheckbox}
    />
  );
}

export function InstallationPicker({
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
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId,
    orgSlug,
  });

  const installationsQuery = useQuery({
    queryKey: KEYS.githubUserOrgs(orgId, connectionId),
    queryFn: async () => {
      const result = await selfClient.callTool({
        name: "GITHUB_LIST_USER_ORGS",
        arguments: { connectionId },
      });
      const content = (result as { content?: Array<{ text?: string }> })
        .content?.[0]?.text;
      if (!content) throw new Error("No response from GITHUB_LIST_USER_ORGS");
      return JSON.parse(content) as {
        installations: GitHubInstallation[];
        appSlug?: string;
      };
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
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-destructive">
          Failed to load GitHub accounts
        </p>
      </div>
    );
  }

  const data = installationsQuery.data;
  if (!data) return null;

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
            Change connection
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
                  Personal account
                </span>
              )}
            </div>
            <span className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              Select →
            </span>
          </button>
        ))}
      </div>

      <div className="px-4 py-3 border-t border-border shrink-0">
        <a
          href={
            data.appSlug
              ? `https://github.com/apps/${data.appSlug}/installations/new`
              : "https://github.com/settings/installations"
          }
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Account not listed?{" "}
          <span className="underline underline-offset-2">
            Install the GitHub App
          </span>
        </a>
      </div>
    </div>
  );
}

export function RepoBrowser({
  connectionId,
  orgId,
  orgSlug,
  installation,
  onSelectRepo,
  isSaving,
  autoRespondEnabled,
  onAutoRespondChange,
  selectedAutomationKeys,
  onAutomationKeysChange,
  hideAutoRespondCheckbox,
}: {
  connectionId: string;
  orgId: string;
  orgSlug: string;
  installation: GitHubInstallation;
  onSelectRepo: (repo: Repo) => void;
  isSaving: boolean;
  autoRespondEnabled: boolean;
  onAutoRespondChange: (value: boolean) => void;
  selectedAutomationKeys: Set<string>;
  onAutomationKeysChange: (next: Set<string>) => void;
  hideAutoRespondCheckbox?: boolean;
}) {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const deferredQuery = useDeferredValue(debouncedQuery);
  const isStale = query !== deferredQuery;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <CollectionSearch
        placeholder="Search repositories..."
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

      {!hideAutoRespondCheckbox && (
        <div className="border-t border-border shrink-0">
          <label className="flex items-center gap-2 px-4 py-3 cursor-pointer select-none">
            <Checkbox
              checked={autoRespondEnabled}
              onCheckedChange={(checked) =>
                onAutoRespondChange(checked === true)
              }
            />
            <span className="text-xs text-foreground">
              Set up GitHub automations for this repo
            </span>
          </label>
          {autoRespondEnabled && (
            <div className="px-4 pb-3 pl-9 flex flex-col gap-1.5">
              {STOREFRONT_GITHUB_AUTOMATIONS.map((spec) => (
                <label
                  key={spec.key}
                  className="flex items-center gap-2 cursor-pointer select-none"
                >
                  <Checkbox
                    checked={selectedAutomationKeys.has(spec.key)}
                    onCheckedChange={(checked) => {
                      const next = new Set(selectedAutomationKeys);
                      if (checked === true) next.add(spec.key);
                      else next.delete(spec.key);
                      onAutomationKeysChange(next);
                    }}
                  />
                  <span className="text-xs text-muted-foreground">
                    {spec.label}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
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
  const githubClient = useMCPClient({ connectionId, orgId, orgSlug });

  const qualifier = installation.type === "User" ? "user" : "org";
  const searchQuery = query
    ? `${qualifier}:${installation.login} ${query} in:name`
    : `${qualifier}:${installation.login}`;

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
          id: number;
          name: string;
          full_name: string;
          html_url: string;
          private: boolean;
          description: string | null;
          updated_at: string;
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
        repositoryId: r.id,
      }));
    },
  });

  if (repos.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-1">
        <p className="text-sm text-muted-foreground">No repositories found</p>
        {query && (
          <p className="text-xs text-muted-foreground/60">
            Try a different search term
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
          </div>
          <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground border border-border rounded px-1.5 py-0.5 shrink-0 leading-none">
            {repo.private ? <Lock01 size={10} /> : <LockUnlocked01 size={10} />}
            {repo.private ? "Private" : "Public"}
          </span>
        </button>
      ))}
    </div>
  );
}

export function AutoInstallGitHubUI({
  status,
  error,
  retry,
}: {
  status: string;
  error: string | null;
  retry: () => void;
}) {
  if (status === "error") {
    return (
      <div className="flex flex-col items-center gap-4 px-6 py-10">
        <div className="size-10 rounded-full bg-destructive/10 flex items-center justify-center">
          <GitHubIcon className="size-5 text-destructive" />
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-sm font-medium">Connection failed</p>
          <p className="text-xs text-muted-foreground max-w-[260px] leading-relaxed">
            {error ?? "Something went wrong while connecting to GitHub."}
          </p>
        </div>
        <button
          type="button"
          onClick={retry}
          className="text-xs font-medium text-foreground border border-border rounded-md px-3 py-1.5 hover:bg-accent transition-colors"
        >
          Try again
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
            ? "Authenticating with GitHub"
            : "Setting up GitHub"}
        </p>
        <p className="text-xs text-muted-foreground">
          {isAuthenticating
            ? "Complete the OAuth flow in your browser"
            : "Installing the GitHub connection..."}
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
