/**
 * Local-Dev Discovery Banner
 *
 * Shows suggestion cards for discovered local-dev instances
 * that haven't been added as projects yet.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useProjectContext } from "@decocms/mesh-sdk";
import { toast } from "sonner";
import { Button } from "@deco/ui/components/button.tsx";
import { KEYS } from "@/web/lib/query-keys";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import type { DiscoveredInstance } from "@/web/hooks/use-local-dev-discovery";

function folderName(root: string): string {
  const parts = root.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || root;
}

interface AddProjectResponse {
  project: { id: string; slug: string; name: string };
  connectionId: string;
  virtualMcpId: string;
}

function DiscoveryCard({ instance }: { instance: DiscoveredInstance }) {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/local-dev/add-project", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: instance.port, root: instance.root }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(
          (err as { error?: string }).error || `HTTP ${res.status}`,
        );
      }
      return (await res.json()) as AddProjectResponse;
    },
    onSuccess: async (result) => {
      toast.success(`Project "${result.project.name}" created`);

      // Pre-select the local-dev virtual MCP and "Direct access" mode
      const locator =
        `${org.slug}/${result.project.slug}` as `${string}/${string}`;
      localStorage.setItem(
        `${locator}:selected-virtual-mcp-id`,
        JSON.stringify(result.virtualMcpId),
      );
      localStorage.setItem(
        LOCALSTORAGE_KEYS.chatSelectedMode(locator),
        JSON.stringify("passthrough"),
      );

      queryClient.cancelQueries({ queryKey: KEYS.localDevDiscovery() });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: KEYS.projects(org.id),
        }),
        queryClient.invalidateQueries({
          queryKey: KEYS.projectPluginConfigs(result.project.id),
        }),
      ]);
      navigate({
        to: "/$org/$project",
        params: { org: org.slug, project: result.project.slug },
      });
    },
    onError: (error) => {
      toast.error(
        "Failed to add project: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    },
  });

  const name = folderName(instance.root);

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-dashed border-emerald-500/40 bg-emerald-50/50 dark:bg-emerald-950/20 px-4 py-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-sm font-medium">
          {instance.port}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{name}</p>
          <p className="text-xs text-muted-foreground truncate">
            {instance.root}
          </p>
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="shrink-0 h-7 text-xs"
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
      >
        {mutation.isPending ? "Adding..." : "Add as project"}
      </Button>
    </div>
  );
}

interface LocalDevBannerProps {
  instances: DiscoveredInstance[];
}

export function LocalDevBanner({ instances }: LocalDevBannerProps) {
  if (instances.length === 0) return null;

  return (
    <div className="px-5 pt-3 space-y-2">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        Local dev servers detected
      </p>
      {instances.map((inst) => (
        <DiscoveryCard key={inst.port} instance={inst} />
      ))}
    </div>
  );
}
