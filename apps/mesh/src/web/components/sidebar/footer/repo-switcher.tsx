/**
 * Sidebar "Add repo" entry. Once the org has at least one added repo (an
 * org-shared repo-scoped GitHub connection), this upgrades from a plain
 * "add a repo to the org" button into a switcher over those repos.
 *
 * Picking a repo depends on which agent is in view:
 *   - a real custom agent → writes `metadata.githubRepo` on it (a top-level
 *     shallow merge, so `ui`/`instructions`/`connections` survive) and opens
 *     its Preview tab in place. The org-shared connection is already injected
 *     into every agent's toolset, so no connection wiring is needed —
 *     SANDBOX_START reads `metadata.githubRepo` and boots the sandbox from it.
 *   - Decopilot (the synthetic default agent, which can't persist a repo) or no
 *     agent → creates, or reuses, a dedicated agent bound to that repo and
 *     opens its Preview.
 */
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { SidebarMenuButton } from "@deco/ui/components/sidebar.tsx";
import { Check, Plus } from "@untitledui/icons";
import { Suspense, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  isDecopilot,
  SELF_MCP_ALIAS_ID,
  useConnections,
  useMCPClient,
  useProjectContext,
  useVirtualMCP,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import type { ConnectionEntity } from "@decocms/mesh-sdk";
import {
  getRepoScope,
  isOrgSharedConnection,
} from "@/shared/github-repo-scope";
import { GitHubIcon } from "@/web/components/icons/github-icon";
import { GitHubRepoPicker } from "@/web/components/github-repo-picker";
import { useNavigateToAgent } from "@/web/hooks/use-navigate-to-agent";
import { invalidateVirtualMcpQueries } from "@/web/lib/query-keys";

type GithubRepoMeta = { owner?: string; name?: string; connectionId?: string };

function AddRepoButton({ onClick }: { onClick: () => void }) {
  return (
    <SidebarMenuButton tooltip="Add repo" onClick={onClick}>
      <GitHubIcon />
      <span>Add repo</span>
    </SidebarMenuButton>
  );
}

function RepoSwitcherInner({ onAddNew }: { onAddNew: () => void }) {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const navigateToAgent = useNavigateToAgent();
  const search = useSearch({ strict: false }) as { virtualmcpid?: string };
  const currentAgentId = search.virtualmcpid ?? null;
  // Decopilot is synthetic and can't hold a persisted repo, so treat it (and
  // the no-agent home) as "create/reuse a repo agent" rather than attach.
  const isRealAgent = !!currentAgentId && !isDecopilot(currentAgentId);

  const connections = useConnections({ slug: "mcp-github" });
  const repos = connections.filter(
    (c) => getRepoScope(c) !== null && isOrgSharedConnection(c),
  );

  const agents = useVirtualMCPs();
  const currentAgent = useVirtualMCP(isRealAgent ? currentAgentId : null);
  const currentRepoConnId =
    (currentAgent?.metadata?.githubRepo as GithubRepoMeta | undefined)
      ?.connectionId ?? null;

  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  // Nothing added yet: fall back to the plain "add a repo to the org" flow so
  // the first repo can still be added from here.
  if (repos.length === 0) {
    return <AddRepoButton onClick={onAddNew} />;
  }

  const attachToCurrent = async (
    githubRepo: Record<string, unknown>,
    label: string,
  ) => {
    await selfClient.callTool({
      name: "COLLECTION_VIRTUAL_MCP_UPDATE",
      arguments: { id: currentAgentId, data: { metadata: { githubRepo } } },
    });
    invalidateVirtualMcpQueries(queryClient, org.id);
    toast.success(`Previewing ${label}`);
    // ponytail: projectRef is keyed on agent+branch, not repo — switching repos
    // on an agent with a live sandbox reuses it; tear the sandbox down first if
    // that turns out to matter.
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, main: "preview" }),
      replace: true,
    });
  };

  const openOrCreateRepoAgent = async (
    githubRepo: Record<string, unknown> & { owner: string; name: string },
    connectionId: string,
    label: string,
  ) => {
    const existing = agents.find((a) => {
      const r = a.metadata?.githubRepo as GithubRepoMeta | undefined;
      return (
        r?.owner?.toLowerCase() === githubRepo.owner.toLowerCase() &&
        r?.name?.toLowerCase() === githubRepo.name.toLowerCase()
      );
    });
    if (existing) {
      navigateToAgent(existing.id, { search: { main: "preview" } });
      return;
    }
    const result = (await selfClient.callTool({
      name: "COLLECTION_VIRTUAL_MCP_CREATE",
      arguments: {
        data: {
          title: githubRepo.name,
          description: `Imported from ${label}`,
          status: "active",
          pinned: false,
          icon: null,
          connections: [{ connection_id: connectionId }],
          metadata: {
            githubRepo,
            instructions: null,
            ui: {
              pinnedViews: null,
              layout: {
                defaultMainView: { type: "preview" },
                chatDefaultOpen: true,
              },
            },
          },
        },
      },
    })) as { structuredContent?: { item?: { id?: string } } };
    const createdId = result.structuredContent?.item?.id;
    invalidateVirtualMcpQueries(queryClient, org.id);
    if (!createdId) throw new Error("Failed to create the repo agent");
    toast.success(`Created ${label}`);
    navigateToAgent(createdId, { search: { main: "preview" } });
  };

  const pick = async (repo: ConnectionEntity) => {
    const scope = getRepoScope(repo);
    if (!scope) return;
    const label = `${scope.owner}/${scope.repo}`;
    const githubRepo = {
      owner: scope.owner,
      name: scope.repo,
      url: `https://github.com/${scope.owner}/${scope.repo}`,
      installationId: scope.installationId,
      connectionId: repo.id,
    };
    try {
      if (isRealAgent) {
        await attachToCurrent(githubRepo, label);
      } else {
        await openOrCreateRepoAgent(githubRepo, repo.id, label);
      }
    } catch (err) {
      toast.error(
        "Failed to set preview repo: " +
          (err instanceof Error ? err.message : "Unknown error"),
      );
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton>
          <GitHubIcon />
          <span>Add repo</span>
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right" className="w-56">
        {repos.map((repo) => {
          const scope = getRepoScope(repo);
          if (!scope) return null;
          return (
            <DropdownMenuItem key={repo.id} onSelect={() => pick(repo)}>
              <GitHubIcon className="size-4 text-muted-foreground" />
              <span className="flex-1 truncate">
                {scope.owner}/{scope.repo}
              </span>
              {repo.id === currentRepoConnId && <Check className="size-4" />}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onAddNew}>
          <Plus className="size-4" />
          Add new repo…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function RepoSwitcher() {
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <>
      <Suspense
        fallback={<AddRepoButton onClick={() => setPickerOpen(true)} />}
      >
        <RepoSwitcherInner onAddNew={() => setPickerOpen(true)} />
      </Suspense>
      <GitHubRepoPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        mode="connection"
      />
    </>
  );
}
