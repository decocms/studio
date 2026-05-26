/**
 * Add Storefront Modal
 *
 * Creates a Storefront Manager virtual MCP scoped to a specific GitHub
 * repository. Two entry paths:
 *  - Browse: pick an installation, then a repo from the picker.
 *  - URL: paste `https://github.com/owner/repo` directly.
 *
 * Writes `metadata.type = "storefront-manager"`, `metadata.githubRepo`,
 * and the XML-structured Storefront Manager instructions. Site URL is
 * collected later via the separate "Set up site monitoring" flow.
 */

import { Suspense, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useConnections,
  useMCPClient,
  useProjectContext,
  useVirtualMCPActions,
  SELF_MCP_ALIAS_ID,
} from "@decocms/mesh-sdk";
import type { ConnectionEntity } from "@decocms/mesh-sdk";
import { toast } from "sonner";
import { ArrowLeft, Loading01 } from "@untitledui/icons";
import { useAutoInstallGitHub } from "@/web/hooks/use-auto-install-github";
import { useNavigateToAgent } from "@/web/hooks/use-navigate-to-agent";
import { invalidateVirtualMcpQueries } from "@/web/lib/query-keys";
import { GitHubIcon } from "@/web/components/icons/github-icon";
import {
  AutoInstallGitHubUI,
  InstallationPicker,
  RepoBrowser,
  type GitHubInstallation,
  type Repo,
} from "@/web/components/github-repo-picker";
import {
  STOREFRONT_GITHUB_AUTOMATIONS,
  setupStorefrontGithubAutomations,
} from "@/tools/virtual/storefront-github-automations";

type Mode = "browse" | "url";

const STOREFRONT_MANAGER_INSTRUCTIONS = `<role>
You are the Storefront Manager for a single storefront — a specific GitHub repository and the live site it serves.
</role>

<capabilities>
- Investigate site issues by calling the Site Diagnostics agent via the \`subtask\` tool. Discover it at call time by listing virtual MCPs (COLLECTION_VIRTUAL_MCP_LIST) and filtering on \`metadata.type === "site-diagnostics"\`.
- Read and modify the repository (issues, files, PRs) through the attached GitHub MCP connection.
- Open issues or PRs when fixing site problems.
</capabilities>

<constraints>
- Stay scoped to this storefront only — the repo in \`metadata.githubRepo\` and the site at \`metadata.storefront.siteUrl\`.
- For performance, SEO, broken-link, or third-party-script questions, delegate to Site Diagnostics via subtask rather than answering from instinct.
- Never modify other storefronts.
</constraints>

<workflows>
1. Diagnosing a site issue:
   a. List virtual MCPs and find the one with \`metadata.type === "site-diagnostics"\`.
   b. Call \`subtask\` with that agent id and a prompt describing what to investigate and the site URL.
   c. Review the report and, if a code change is needed, open or update a GitHub issue with the findings.
</workflows>`;

function parseGitHubUrl(
  raw: string,
): { owner: string; name: string; url: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname !== "github.com") return null;
    const parts = parsed.pathname
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/, "")
      .split("/");
    if (parts.length < 2) return null;
    const [owner, name] = parts;
    if (!owner || !name) return null;
    return {
      owner,
      name,
      url: `https://github.com/${owner}/${name}`,
    };
  } catch {
    return null;
  }
}

export function AddStorefrontModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [mode, setMode] = useState<Mode>("browse");
  const [selectedInstallation, setSelectedInstallation] =
    useState<GitHubInstallation | null>(null);

  const handleClose = () => {
    setMode("browse");
    setSelectedInstallation(null);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleClose();
        else onOpenChange(true);
      }}
    >
      <DialogContent className="sm:max-w-[560px] h-[85svh] sm:h-[560px] p-0 gap-0 overflow-hidden flex flex-col">
        <DialogHeader className="sr-only">
          <DialogTitle>Add a storefront</DialogTitle>
        </DialogHeader>
        <Header
          mode={mode}
          selectedInstallation={selectedInstallation}
          onBackToAccounts={() => setSelectedInstallation(null)}
          onSwitchMode={(next) => {
            setSelectedInstallation(null);
            setMode(next);
          }}
        />
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
            {mode === "url" ? (
              <UrlEntry onComplete={handleClose} />
            ) : (
              <BrowseFlow
                selectedInstallation={selectedInstallation}
                onSelectInstallation={setSelectedInstallation}
                onComplete={handleClose}
              />
            )}
          </Suspense>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Header({
  mode,
  selectedInstallation,
  onBackToAccounts,
  onSwitchMode,
}: {
  mode: Mode;
  selectedInstallation: GitHubInstallation | null;
  onBackToAccounts: () => void;
  onSwitchMode: (next: Mode) => void;
}) {
  return (
    <div className="flex items-center h-12 border-b border-border px-4 gap-3 shrink-0">
      {selectedInstallation && mode === "browse" ? (
        <>
          <button
            type="button"
            onClick={onBackToAccounts}
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
            Add a storefront
          </span>
        </>
      )}
      <div className="ml-auto">
        <button
          type="button"
          onClick={() => onSwitchMode(mode === "browse" ? "url" : "browse")}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {mode === "browse" ? "Paste URL instead" : "Browse repos"}
        </button>
      </div>
    </div>
  );
}

function BrowseFlow({
  selectedInstallation,
  onSelectInstallation,
  onComplete,
}: {
  selectedInstallation: GitHubInstallation | null;
  onSelectInstallation: (inst: GitHubInstallation | null) => void;
  onComplete: () => void;
}) {
  const { org } = useProjectContext();
  const githubConnections = useConnections({ slug: "mcp-github" });
  const [selectedConnection, setSelectedConnection] =
    useState<ConnectionEntity | null>(null);
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

  const createStorefront = useCreateStorefront({ onComplete });

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
      onSelectRepo={(repo) =>
        createStorefront.mutate({
          repo,
          connectionId: effectiveConnection.id,
          installationId: selectedInstallation.installationId,
          selectedAutomationKeys: autoRespondEnabled
            ? selectedAutomationKeys
            : new Set<string>(),
          githubCallTool: (req) => githubClient.callTool(req),
        })
      }
      isSaving={createStorefront.isPending}
      autoRespondEnabled={autoRespondEnabled}
      onAutoRespondChange={setAutoRespondEnabled}
      selectedAutomationKeys={selectedAutomationKeys}
      onAutomationKeysChange={setSelectedAutomationKeys}
    />
  );
}

function UrlEntry({ onComplete }: { onComplete: () => void }) {
  const { org } = useProjectContext();
  const [url, setUrl] = useState("");
  const githubConnections = useConnections({ slug: "mcp-github" });
  const createStorefront = useCreateStorefront({ onComplete });
  const githubClient = useMCPClient({
    connectionId: githubConnections[0]?.id ?? "",
    orgId: org.id,
    orgSlug: org.slug,
  });
  const defaultEnabledKeys = STOREFRONT_GITHUB_AUTOMATIONS.filter(
    (s) => s.defaultEnabled,
  ).map((s) => s.key);

  const parsed = parseGitHubUrl(url);
  const canSubmit =
    parsed !== null &&
    githubConnections.length > 0 &&
    !createStorefront.isPending;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!parsed) return;
        const connectionId = githubConnections[0]?.id;
        if (!connectionId) {
          toast.error("Connect GitHub first.");
          return;
        }
        createStorefront.mutate({
          repo: {
            owner: parsed.owner,
            name: parsed.name,
            fullName: `${parsed.owner}/${parsed.name}`,
            url: parsed.url,
            private: false,
            description: null,
            updatedAt: "",
          },
          connectionId,
          installationId: undefined,
          selectedAutomationKeys: new Set(defaultEnabledKeys),
          githubCallTool: (req) => githubClient.callTool(req),
        });
      }}
      className="flex-1 flex flex-col px-4 py-5 gap-4 overflow-y-auto"
    >
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="storefront-repo-url"
          className="text-xs font-medium text-foreground"
        >
          GitHub repository URL
        </label>
        <Input
          id="storefront-repo-url"
          type="url"
          placeholder="https://github.com/owner/repo"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          autoFocus
        />
        <p className="text-xs text-muted-foreground">
          Paste the repo URL. Works for public and private repos under your
          connected GitHub account.
        </p>
      </div>
      {githubConnections.length === 0 && (
        <p className="text-xs text-destructive">
          Connect GitHub first from the "Connect GitHub" checklist item.
        </p>
      )}
      <div className="mt-auto flex justify-end">
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {createStorefront.isPending ? "Adding..." : "Add storefront"}
        </Button>
      </div>
    </form>
  );
}

type CreateStorefrontArgs = {
  repo: Repo;
  connectionId: string;
  installationId: number | undefined;
  selectedAutomationKeys: Set<string>;
  /** Callable for the GitHub MCP connection; supplied by the caller because
   *  the connection id is dynamic and `useMCPClient` must be called from a
   *  component scope. */
  githubCallTool: (req: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<unknown>;
};

function useCreateStorefront({ onComplete }: { onComplete: () => void }) {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const navigateToAgent = useNavigateToAgent();
  const virtualMcpActions = useVirtualMCPActions();
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useMutation({
    mutationFn: async ({
      repo,
      connectionId,
      installationId,
      selectedAutomationKeys,
      githubCallTool,
    }: CreateStorefrontArgs) => {
      const virtualMcp = await virtualMcpActions.create.mutateAsync({
        title: `${repo.owner}/${repo.name}`,
        description: repo.description || `Storefront at ${repo.url}`,
        icon: "icon://Globe02?color=sky",
        status: "active",
        connections: [
          {
            connection_id: connectionId,
            selected_tools: null,
            selected_resources: null,
            selected_prompts: null,
          },
        ],
        metadata: {
          type: "storefront-manager",
          instructions: STOREFRONT_MANAGER_INSTRUCTIONS,
          githubRepo: {
            owner: repo.owner,
            name: repo.name,
            url: repo.url,
            installationId,
            connectionId,
          },
        },
      });

      if (selectedAutomationKeys.size > 0 && virtualMcp.id) {
        const result = await setupStorefrontGithubAutomations({
          githubCallTool,
          selfCallTool: (req) => selfClient.callTool(req),
          virtualMcpId: virtualMcp.id,
          repo,
          connectionId,
          selectedKeys: selectedAutomationKeys,
        }).catch((err) => {
          console.error("Failed to set up GitHub automations:", err);
          return { total: selectedAutomationKeys.size, failed: -1 };
        });
        if (result.failed === -1) {
          toast.warning(
            "Storefront created, but couldn't set up GitHub automations. Add them from the automations view.",
          );
        } else if (result.failed > 0) {
          toast.warning(
            `Storefront created; set up ${result.total - result.failed}/${result.total} GitHub automations. Add the rest from the automations view.`,
          );
        }
      }

      return { virtualMcp, repo };
    },
    onSuccess: ({ virtualMcp, repo }) => {
      invalidateVirtualMcpQueries(queryClient, org.id);
      toast.success(`Storefront ${repo.owner}/${repo.name} added.`);
      onComplete();
      navigateToAgent(virtualMcp.id!);
    },
    onError: (error) => {
      toast.error(
        "Failed to add storefront: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    },
  });
}
