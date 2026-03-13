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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { authClient } from "@/web/lib/auth-client";
import { generatePrefixedId } from "@/shared/utils/generate-id";
import { KEYS } from "@/web/lib/query-keys";
import { generateSlug } from "@/web/lib/slug";
import type { Project } from "@/web/hooks/use-project";

interface DecoSite {
  name: string;
  domains: { domain: string; production: boolean }[] | null;
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
}

type ProjectCreateOutput = { project: Project };

export function ImportFromDecoDialog({
  open,
  onOpenChange,
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

      // 2. Create a project named after the site
      const result = (await client.callTool({
        name: "PROJECT_CREATE",
        arguments: {
          organizationId: org.id,
          slug: generateSlug(siteName),
          name: siteName,
          description: "Imported from deco.cx",
          enabledPlugins: [],
          ui: {
            banner: null,
            bannerColor: "#22C55E",
            icon: null,
            themeColor: "#22C55E",
          },
        },
      })) as { structuredContent?: unknown };

      const payload = (result.structuredContent ??
        result) as ProjectCreateOutput;
      const project = payload.project;

      // 3. Link the connection to the project
      await client.callTool({
        name: "PROJECT_CONNECTION_ADD",
        arguments: {
          projectId: project.id,
          connectionId: connId,
        },
      });

      // 4. Pin the default sidebar views for this site
      await client.callTool({
        name: "PROJECT_PINNED_VIEWS_UPDATE",
        arguments: {
          projectId: project.id,
          pinnedViews: [
            {
              connectionId: connId,
              toolName: "list_environments",
              label: "Preview",
              icon: null,
            },
            {
              connectionId: connId,
              toolName: "file_explorer",
              label: "File Explorer",
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
      });

      return { project, connId };
    },
    onSuccess: ({ project }) => {
      queryClient.invalidateQueries({ queryKey: KEYS.projects(org.id) });
      toast.success(`Imported ${project.slug} from deco.cx`);
      handleClose(false);
      navigate({
        to: "/$org/$project",
        params: { org: org.slug, project: project.slug },
      });
    },
    onError: (err) => {
      toast.error(
        "Import failed: " +
          (err instanceof Error ? err.message : "Unknown error"),
      );
    },
  });

  const userEmail = session?.user?.email ?? "";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Import from deco.cx</DialogTitle>
          <DialogDescription>
            {userEmail
              ? `Sites available for ${userEmail}`
              : "Select the site you want to import."}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-24">
          {isLoading && (
            <div className="flex items-center justify-center h-24 text-sm text-muted-foreground">
              Loading sites...
            </div>
          )}

          {!isLoading && sitesError && (
            <div className="flex flex-col items-center justify-center h-24 gap-2 text-sm text-destructive">
              <span>{(sitesError as Error).message}</span>
              <p className="text-xs text-muted-foreground">
                Make sure DECO_SUPABASE_URL and DECO_SUPABASE_SERVICE_KEY are
                configured.
              </p>
            </div>
          )}

          {!isLoading && !sitesError && sites.length === 0 && (
            <div className="flex items-center justify-center h-24 text-sm text-muted-foreground">
              No sites found for this account.
            </div>
          )}

          {!isLoading && sites.length > 0 && (
            <div className="space-y-3">
              <Input
                placeholder="Search sites..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
              />
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {filteredSites.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No sites match &ldquo;{search}&rdquo;
                  </p>
                )}
                {filteredSites.map((site) => (
                  <button
                    key={site.name}
                    type="button"
                    onClick={() => setSelectedSite(site.name)}
                    className={cn(
                      "flex flex-col w-full text-left rounded-lg border px-4 py-3 transition-colors",
                      selectedSite === site.name
                        ? "border-primary bg-primary/5 ring-1 ring-primary"
                        : "border-border hover:bg-muted/50",
                    )}
                  >
                    <span className="text-sm font-medium">{site.name}</span>
                    {site.domains?.[0] && (
                      <span className="text-xs text-muted-foreground">
                        {site.domains[0].domain}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
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
