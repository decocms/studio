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
  useConnections,
  SELF_MCP_ALIAS_ID,
} from "@decocms/mesh-sdk";
import type { ConnectionEntity } from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import { toast } from "sonner";
import {
  ArrowLeft,
  Loading01,
  Lock01,
  LockUnlocked01,
} from "@untitledui/icons";
import { useAutoInstallGitHub } from "@/web/hooks/use-auto-install-github";
import { useNavigateToAgent } from "@/web/hooks/use-navigate-to-agent";
import { usePreferences } from "@/web/hooks/use-preferences.ts";
import { GitHubIcon } from "@/web/components/icons/github-icon";

interface GitHubInstallation {
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
  const [preferences] = usePreferences();
  const [selectedInstallation, setSelectedInstallation] =
    useState<GitHubInstallation | null>(null);

  if (!preferences.experimental_vibecode) {
    return null;
  }

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
  const [selectedConnection, setSelectedConnection] =
    useState<ConnectionEntity | null>(null);
  const [autoRespondToIssues, setAutoRespondToIssues] = useState(true);
  const effectiveAutoRespond = hideAutoRespondCheckbox
    ? true
    : autoRespondToIssues;

  const githubConnections = useConnections({ slug: "mcp-github" });

  const autoInstall = useAutoInstallGitHub({
    enabled: githubConnections.length === 0,
  });

  const effectiveConnection =
    githubConnections.length === 1
      ? (githubConnections[0] ?? null)
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

  // Runtime detection moved server-side into VM_START (see
  // github-runtime-detect.ts). Here we only pull AGENTS.md / CLAUDE.md so the
  // agent has instructions ready even before the first VM boots.
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

  const setupIssueAutomation = async ({
    virtualMcpId,
    repo,
    connectionId,
  }: {
    virtualMcpId: string;
    repo: Repo;
    connectionId: string;
  }) => {
    const triggerListResult = (await githubClient.callTool({
      name: "TRIGGER_LIST",
      arguments: {},
    })) as { structuredContent?: unknown };

    const triggerPayload = (triggerListResult.structuredContent ??
      triggerListResult) as {
      triggers?: Array<{
        type: string;
        params?: Array<{ name: string }> | Record<string, unknown>;
        paramsSchema?: Record<string, unknown>;
      }>;
    };

    const issueTrigger =
      triggerPayload.triggers?.find((t) => t.type === "github.issues.opened") ??
      triggerPayload.triggers?.find((t) => {
        const type = t.type.toLowerCase();
        return (
          /\bissues?\./.test(type) &&
          (type.endsWith(".opened") || type.endsWith(".created"))
        );
      });

    if (!issueTrigger) {
      throw new Error("No issue-created trigger exposed by GitHub connection");
    }

    const paramNames = new Set<string>();
    if (Array.isArray(issueTrigger.params)) {
      for (const p of issueTrigger.params) paramNames.add(p.name);
    } else if (issueTrigger.params && typeof issueTrigger.params === "object") {
      for (const k of Object.keys(issueTrigger.params)) paramNames.add(k);
    }
    if (issueTrigger.paramsSchema) {
      for (const k of Object.keys(issueTrigger.paramsSchema)) paramNames.add(k);
    }

    const params: Record<string, string> = {};
    if (paramNames.has("repo")) {
      params.repo = `${repo.owner}/${repo.name}`;
    } else {
      if (paramNames.has("owner")) params.owner = repo.owner;
      if (paramNames.has("name")) params.name = repo.name;
      if (paramNames.has("repository"))
        params.repository = `${repo.owner}/${repo.name}`;
    }

    const automationInstructions = `A new GitHub issue has been opened in ${repo.owner}/${repo.name}. Read the issue details, explore the relevant code in the repository, create a new branch, implement the fix or feature requested, and open a pull request that resolves the issue. Reference the issue number in the PR description.`;

    const automationResult = (await selfClient.callTool({
      name: "AUTOMATION_CREATE",
      arguments: {
        name: `${repo.name}: auto-respond to issues`,
        virtual_mcp_id: virtualMcpId,
        messages: automationInstructions,
        active: true,
      },
    })) as { structuredContent?: unknown };

    const automationPayload = (automationResult.structuredContent ??
      automationResult) as { id: string };

    await selfClient.callTool({
      name: "AUTOMATION_TRIGGER_ADD",
      arguments: {
        automation_id: automationPayload.id,
        type: "event",
        connection_id: connectionId,
        event_type: issueTrigger.type,
        params,
      },
    });
  };

  const importMutation = useMutation({
    mutationFn: async (repo: Repo) => {
      if (!effectiveConnection || !selectedInstallation) {
        throw new Error("No GitHub connection or installation");
      }

      const connectionId = effectiveConnection.id;

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
                installationId: selectedInstallation.installationId,
                connectionId,
              },
              instructions: null,
              // runtime is resolved server-side inside VM_START's lockfile
              // probe (github-runtime-detect.ts). Writing a client-side
              // sentinel here only re-created the race the probe fixed.
              ui: {
                pinnedViews: null,
                layout: {
                  defaultMainView: {
                    type: "preview",
                  },
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

      if (effectiveAutoRespond) {
        await setupIssueAutomation({
          virtualMcpId,
          repo,
          connectionId,
        }).catch((err) => {
          console.error("Failed to set up issue automation:", err);
          toast.warning(
            "Imported repo, but failed to set up issue auto-response. You can add the trigger manually from the automations view.",
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

  if (githubConnections.length === 0 && autoInstall.status === "idle") {
    return (
      <AutoInstallGitHubUI
        status="installing"
        error={null}
        retry={autoInstall.retry}
      />
    );
  }

  if (githubConnections.length > 1 && !effectiveConnection) {
    return (
      <div className="flex flex-col py-2">
        <div className="px-4 py-2">
          <p className="text-xs font-medium text-muted-foreground">
            Select a connection
          </p>
        </div>
        {githubConnections.map((conn) => (
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
        showBackButton={githubConnections.length > 1}
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
      autoRespondToIssues={autoRespondToIssues}
      onAutoRespondChange={setAutoRespondToIssues}
      hideAutoRespondCheckbox={hideAutoRespondCheckbox}
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

function RepoBrowser({
  connectionId,
  orgId,
  orgSlug,
  installation,
  onSelectRepo,
  isSaving,
  autoRespondToIssues,
  onAutoRespondChange,
  hideAutoRespondCheckbox,
}: {
  connectionId: string;
  orgId: string;
  orgSlug: string;
  installation: GitHubInstallation;
  onSelectRepo: (repo: Repo) => void;
  isSaving: boolean;
  autoRespondToIssues: boolean;
  onAutoRespondChange: (value: boolean) => void;
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
        <label className="flex items-center gap-2 px-4 py-3 border-t border-border shrink-0 cursor-pointer select-none">
          <Checkbox
            checked={autoRespondToIssues}
            onCheckedChange={(checked) => onAutoRespondChange(checked === true)}
          />
          <span className="text-xs text-foreground">
            Auto-respond to new issues with a PR
          </span>
        </label>
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

function AutoInstallGitHubUI({
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
