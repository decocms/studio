import { useState } from "react";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
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
import { generatePrefixedId } from "@/shared/utils/generate-id";
import { KEYS } from "@/web/lib/query-keys";
import { generateSlug } from "@/web/lib/slug";
import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";

interface DecoSite {
  name: string;
  domains: { domain: string; production: boolean }[] | null;
  thumb_url: string | null;
}

interface DecoSitesResponse {
  sites: DecoSite[];
}

async function loadDecoSites(): Promise<DecoSitesResponse> {
  const res = await fetch("/api/deco-sites");
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();

  const [selectedSite, setSelectedSite] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const {
    data: decoData,
    isLoading,
    error: sitesError,
  } = useQuery({
    queryKey: ["deco-sites", session?.user?.email],
    queryFn: loadDecoSites,
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
      // 1. Create the connection server-side so the deco.cx API key never
      //    reaches the browser — the backend fetches and encrypts it directly.
      const connId = generatePrefixedId("conn");
      const connRes = await fetch("/api/deco-sites/connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteName, connId, orgId: org.id }),
      });
      if (!connRes.ok) {
        const body = (await connRes.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          body.error ?? `Failed to create connection (${connRes.status})`,
        );
      }

      const slug = generateSlug(siteName);

      // 2. Create a project (virtual MCP with subtype "project") with the connection already linked
      const result = (await client.callTool({
        name: "COLLECTION_VIRTUAL_MCP_CREATE",
        arguments: {
          data: {
            title: siteName,
            description: "Imported from deco.cx",
            subtype: "project",
            metadata: {
              instructions: null,
              enabled_plugins: [],
              ui: {
                banner: null,
                bannerColor: "#22C55E",
                icon: null,
                themeColor: "#22C55E",
                slug,
                pinnedViews: [
                  {
                    connectionId: connId,
                    toolName: "file_explorer",
                    label: "Preview",
                    icon: null,
                  },
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
              },
            },
            connections: [{ connection_id: connId }],
          },
        },
      })) as { structuredContent?: unknown };

      const payload = (result.structuredContent ??
        result) as VirtualMCPCreateOutput;

      return { slug, virtualMcpId: payload.item.id, connId };
    },
    onSuccess: ({ slug, virtualMcpId, connId }) => {
      queryClient.invalidateQueries({ queryKey: KEYS.projects(org.id) });
      toast.success(`Imported ${slug} from deco.cx`);
      handleClose(false);
      localStorage.setItem("mesh:sidebar-open", JSON.stringify(false));
      navigate({
        to: "/$org/p/$virtualMcpId/apps/$connectionId/$toolName",
        params: {
          org: org.slug,
          virtualMcpId,
          connectionId: connId,
          toolName: "file_explorer",
        },
      });
    },
    onError: (err) => {
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
          <button
            type="button"
            onClick={() => (onBack ? onBack() : handleClose(false))}
            className="flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Go back"
          >
            <ArrowLeft size={18} />
          </button>
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
          {isLoading && (
            <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
              Loading sites...
            </div>
          )}

          {!isLoading && !sitesError && sites.length === 0 && (
            <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
              No sites found for this account.
            </div>
          )}

          {!isLoading && sites.length > 0 && (
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
              isLoading
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
