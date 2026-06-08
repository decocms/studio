import { useState } from "react";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SELF_MCP_ALIAS_ID,
  useConnections,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useAutoInstallGitHub } from "@/web/hooks/use-auto-install-github";
import { useNavigateToAgent } from "@/web/hooks/use-navigate-to-agent";
import {
  DECO_SITES_GITHUB_OWNER,
  decoSiteGithubRepo,
} from "@/shared/deco-sites-github";
import {
  fetchGithubInstallations,
  findGithubInstallation,
} from "@/web/lib/github-installations";
import { provisionRepoScopedGithubConnection } from "@/web/lib/provision-repo-scoped-github-connection";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { ArrowLeft } from "@untitledui/icons";
import { authClient } from "@/web/lib/auth-client";
import { KEYS } from "@/web/lib/query-keys";
import { generateSlug } from "@/web/lib/slug";
import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import { track } from "@/web/lib/posthog-client";

interface DecoSite {
  name: string;
  domains: { domain: string; production: boolean }[] | null;
  thumb_url: string | null;
}

interface DecoSitesResponse {
  sites: DecoSite[];
}

async function loadDecoSites(orgSlug: string): Promise<DecoSitesResponse> {
  const res = await fetch(`/api/${orgSlug}/deco-sites`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to load sites (${res.status})`);
  }
  return res.json() as Promise<DecoSitesResponse>;
}

interface ImportFromDecoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBack?: () => void;
}

type VirtualMCPCreateOutput = {
  item: {
    id: string;
    title: string;
    metadata?: {
      ui?: { slug?: string } | null;
      migrated_project_slug?: string;
    } | null;
  };
};

export function ImportFromDecoDialog({
  open,
  onOpenChange,
  onBack,
}: ImportFromDecoDialogProps) {
  const { org } = useProjectContext();
  const navigateToAgent = useNavigateToAgent();
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();

  const [selectedSite, setSelectedSite] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const githubConnections = useConnections({ slug: "mcp-github" });
  const autoInstall = useAutoInstallGitHub({
    enabled: open && githubConnections.length === 0,
  });
  const githubConnection = githubConnections[0] ?? null;
  const githubClient = useMCPClient({
    connectionId: githubConnection?.id ?? "",
    orgId: org.id,
    orgSlug: org.slug,
  });

  const githubSetupPending =
    open &&
    githubConnections.length === 0 &&
    (autoInstall.status === "installing" ||
      autoInstall.status === "authenticating" ||
      autoInstall.status === "idle");

  const {
    data: decoData,
    isLoading,
    error: sitesError,
  } = useQuery({
    queryKey: KEYS.decoSites(session?.user?.email),
    queryFn: () => loadDecoSites(org.slug),
    enabled: open && Boolean(session?.user?.email),
    staleTime: 60_000,
    retry: false,
  });

  const sites = decoData?.sites ?? [];

  const handleClose = (nextOpen: boolean) => {
    if (!nextOpen) {
      setSelectedSite(null);
      setSearch("");
    }
    onOpenChange(nextOpen);
  };

  const filteredSites = sites.filter(
    (s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.domains?.[0]?.domain.toLowerCase().includes(search.toLowerCase()),
  );

  const isSelectedVisible =
    !selectedSite || filteredSites.some((s) => s.name === selectedSite);

  const importMutation = useMutation({
    mutationFn: async (siteName: string) => {
      if (!githubConnection) {
        throw new Error(
          "GitHub is not connected. Complete GitHub setup and try again.",
        );
      }

      track("deco_site_import_started", { site_name: siteName });

      const { installations, appSlug } = await fetchGithubInstallations(
        (req) => client.callTool(req),
        githubConnection.id,
      );
      const decoSitesInstallation = findGithubInstallation(
        installations,
        DECO_SITES_GITHUB_OWNER,
      );
      if (!decoSitesInstallation) {
        const installUrl = appSlug
          ? `https://github.com/apps/${appSlug}/installations/new`
          : "https://github.com/settings/installations";
        throw new Error(
          `Install the GitHub App on the "${DECO_SITES_GITHUB_OWNER}" organization to import this site. ${installUrl}`,
        );
      }

      const githubRepo = decoSiteGithubRepo(siteName);
      let decoConnId: string | null = null;
      let githubChildConnId: string | null = null;
      let createdAgentId: string | null = null;

      const rollback = async () => {
        if (createdAgentId) {
          await client
            .callTool({
              name: "COLLECTION_VIRTUAL_MCP_DELETE",
              arguments: { id: createdAgentId },
            })
            .catch(() => {});
        }
        if (githubChildConnId) {
          await client
            .callTool({
              name: "COLLECTION_CONNECTIONS_DELETE",
              arguments: { id: githubChildConnId, force: true },
            })
            .catch(() => {});
        }
        if (decoConnId) {
          await client
            .callTool({
              name: "COLLECTION_CONNECTIONS_DELETE",
              arguments: { id: decoConnId, force: true },
            })
            .catch(() => {});
        }
      };

      try {
        // 1. Create the connection server-side so the deco.cx API key never
        //    reaches the browser — the backend fetches and encrypts it directly.
        const connRes = await fetch(`/api/${org.slug}/deco-sites/connection`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ siteName, orgId: org.id }),
        });
        const connBody = (await connRes.json().catch(() => ({}))) as {
          connId?: string;
          icon?: string | null;
          error?: string;
        };
        if (!connRes.ok) {
          throw new Error(
            connBody.error ?? `Failed to create connection (${connRes.status})`,
          );
        }

        const connId = connBody.connId;
        if (!connId) {
          throw new Error("Server did not return a connection ID");
        }
        decoConnId = connId;

        const { childConnectionId } = await provisionRepoScopedGithubConnection(
          {
            orgSlug: org.slug,
            sourceConnection: githubConnection,
            installationId: decoSitesInstallation.installationId,
            owner: githubRepo.owner,
            repo: githubRepo.name,
            githubCallTool: (req) => githubClient.callTool(req),
            selfCallTool: (req) => client.callTool(req),
          },
        );
        githubChildConnId = childConnectionId;

        const projectIcon = connBody.icon ?? null;
        const slug = generateSlug(siteName);

        // 2. Create a space (virtual MCP) wired to both admin-mcp and GitHub.
        const result = (await client.callTool({
          name: "COLLECTION_VIRTUAL_MCP_CREATE",
          arguments: {
            data: {
              title: siteName,
              description: "Imported from deco.cx",
              pinned: true,
              icon: projectIcon ?? null,
              subtype: "project",
              metadata: {
                instructions: null,
                enabled_plugins: [],
                githubRepo: {
                  owner: githubRepo.owner,
                  name: githubRepo.name,
                  url: githubRepo.url,
                  installationId: decoSitesInstallation.installationId,
                  connectionId: childConnectionId,
                },
                ui: {
                  banner: null,
                  bannerColor: "#22C55E",
                  icon: projectIcon,
                  themeColor: "#22C55E",
                  slug,
                  pinnedViews: [
                    {
                      connectionId: connId,
                      toolName: "fetch_assets",
                      label: "Assets",
                      icon: null,
                    },
                    {
                      connectionId: connId,
                      toolName: "get_monitor_data",
                      label: "Monitor",
                      icon: null,
                    },
                  ],
                  layout: {
                    defaultMainView: { type: "preview" },
                    chatDefaultOpen: true,
                  },
                },
              },
              connections: [
                { connection_id: connId },
                { connection_id: childConnectionId },
              ],
            },
          },
        })) as { structuredContent?: unknown };

        const payload = (result.structuredContent ??
          result) as VirtualMCPCreateOutput;

        if (!payload.item?.id) {
          throw new Error("Failed to create the imported agent");
        }
        createdAgentId = payload.item.id;

        return {
          slug,
          virtualMcpId: payload.item.id,
          connId,
          item: payload.item,
        };
      } catch (err) {
        await rollback();
        throw err;
      }
    },
    onSuccess: ({ slug, virtualMcpId, item }) => {
      track("deco_site_import_succeeded", {
        site_name: item.title,
        virtual_mcp_id: virtualMcpId,
        slug,
      });
      // Seed the individual item cache so useVirtualMCP resolves instantly on
      // the redirected page without waiting for a network round-trip.
      queryClient.setQueryData(
        KEYS.collectionItem(client, org.id, "", "VIRTUAL_MCP", virtualMcpId),
        { item },
      );

      // Invalidate the projects list using a predicate — the collection list
      // key starts with the client instance, so a plain queryKey prefix never
      // matches it.
      queryClient.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey;
          return (
            key[1] === org.id &&
            key[3] === "collection" &&
            key[4] === "VIRTUAL_MCP"
          );
        },
      });
      // Also invalidate the legacy projects key for any other consumers.
      queryClient.invalidateQueries({ queryKey: KEYS.projects(org.id) });
      toast.success(`Imported ${slug} from deco.cx`);
      handleClose(false);
      localStorage.setItem("mesh:sidebar-open", JSON.stringify(false));
      navigateToAgent(virtualMcpId);
    },
    onError: (err) => {
      track("deco_site_import_failed", {
        error: err instanceof Error ? err.message : "Unknown error",
      });
      toast.error(
        "Import failed: " +
          (err instanceof Error ? err.message : "Unknown error"),
      );
    },
  });

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[900px] p-0 gap-0 overflow-hidden">
        <DialogHeader className="sr-only">
          <DialogTitle>Import from deco.cx</DialogTitle>
        </DialogHeader>

        <div className="flex items-center h-12 border-b border-border px-4 gap-3">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Go back"
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <span className="text-sm font-medium text-foreground">
            Import from deco.cx
          </span>
        </div>

        <div>
          <CollectionSearch
            value={search}
            onChange={setSearch}
            placeholder="Search sites..."
            onKeyDown={(e) => {
              if (e.key === "Escape") setSearch("");
            }}
          />
        </div>

        <div className="pb-0 min-h-[300px]">
          {autoInstall.status === "error" && (
            <div className="flex flex-col items-center justify-center gap-3 h-48 px-8 text-center">
              <p className="text-sm text-destructive">
                {autoInstall.error ?? "Failed to connect GitHub"}
              </p>
              <Button variant="outline" size="sm" onClick={autoInstall.retry}>
                Retry GitHub setup
              </Button>
            </div>
          )}

          {githubSetupPending && autoInstall.status !== "error" && (
            <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
              Setting up GitHub connection...
            </div>
          )}

          {isLoading &&
            !githubSetupPending &&
            autoInstall.status !== "error" && (
              <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
                Loading sites...
              </div>
            )}

          {!isLoading &&
            !githubSetupPending &&
            autoInstall.status !== "error" &&
            !sitesError &&
            sites.length === 0 && (
              <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
                No sites found for this account.
              </div>
            )}

          {!isLoading &&
            !githubSetupPending &&
            autoInstall.status !== "error" &&
            sites.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 max-h-[420px] overflow-y-auto py-4 px-8 [scrollbar-gutter:stable]">
                {filteredSites.length === 0 && (
                  <p className="col-span-3 text-sm text-muted-foreground text-center py-8">
                    No sites match &ldquo;{search}&rdquo;
                  </p>
                )}
                {filteredSites.map((site) => {
                  const domain =
                    site.domains?.find((d) => d.production)?.domain ??
                    site.domains?.[0]?.domain;
                  const isSelected = selectedSite === site.name;
                  return (
                    <button
                      key={site.name}
                      type="button"
                      onClick={() => setSelectedSite(site.name)}
                      className={cn(
                        "flex flex-col rounded-xl border overflow-hidden text-left transition-all cursor-pointer",
                        isSelected
                          ? "border-primary ring-1 ring-primary"
                          : "border-border hover:border-muted-foreground/40",
                      )}
                    >
                      {/* Thumbnail */}
                      <div className="w-full aspect-video bg-muted overflow-hidden">
                        {site.thumb_url ? (
                          <img
                            src={site.thumb_url}
                            alt={site.name}
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div className="w-full h-full bg-muted" />
                        )}
                      </div>
                      {/* Info */}
                      <div className="px-4 py-3">
                        <p className="text-sm font-medium text-foreground truncate">
                          {site.name}
                        </p>
                        {domain && (
                          <p className="text-xs text-muted-foreground truncate mt-0.5">
                            {domain}
                          </p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
        </div>

        <DialogFooter className="px-8 py-5 border-t border-border">
          <Button
            variant="outline"
            onClick={() => handleClose(false)}
            disabled={importMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            disabled={
              !selectedSite ||
              !isSelectedVisible ||
              importMutation.isPending ||
              isLoading ||
              githubSetupPending ||
              !githubConnection ||
              autoInstall.status === "error"
            }
            onClick={() => selectedSite && importMutation.mutate(selectedSite)}
          >
            {importMutation.isPending ? "Importing..." : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
