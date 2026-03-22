import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@deco/ui/components/switch.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { toast } from "sonner";
import {
  useProjectContext,
  useMCPClient,
  useVirtualMCP,
  SELF_MCP_ALIAS_ID,
} from "@decocms/mesh-sdk";
import { getUIResourceUri } from "@/mcp-apps/types.ts";
import { KEYS } from "@/web/lib/query-keys";
import { unwrapToolResult } from "@/web/lib/unwrap-tool-result";

interface UITool {
  name: string;
  description?: string;
}

interface PinnedView {
  connectionId: string;
  toolName: string;
  label: string;
  icon: string | null;
}

interface ConnectionWithTools {
  id: string;
  title: string;
  icon: string | null;
  uiTools: UITool[];
}

function ConnectionToolsSection({
  connection,
  pinnedViews,
  isSaving,
  onTogglePin,
  onLabelChange,
}: {
  connection: ConnectionWithTools;
  pinnedViews: PinnedView[];
  isSaving: boolean;
  onTogglePin: (
    connectionId: string,
    toolName: string,
    connectionIcon: string | null,
  ) => void;
  onLabelChange: (
    connectionId: string,
    toolName: string,
    label: string,
  ) => void;
}) {
  if (connection.uiTools.length === 0) return null;

  const isPinned = (toolName: string) =>
    pinnedViews.some(
      (v) => v.connectionId === connection.id && v.toolName === toolName,
    );

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        {connection.icon ? (
          <img
            src={connection.icon}
            alt=""
            className="size-4 shrink-0 rounded"
          />
        ) : (
          <div className="size-4 shrink-0 rounded bg-muted flex items-center justify-center">
            <span className="text-[8px] font-medium text-muted-foreground">
              {connection.title.charAt(0).toUpperCase()}
            </span>
          </div>
        )}
        <h3 className="text-sm font-medium text-foreground">
          {connection.title}
        </h3>
      </div>
      <div className="flex flex-col">
        {connection.uiTools.map((tool) => {
          const pinned = isPinned(tool.name);
          const pinnedView = pinnedViews.find(
            (v) => v.connectionId === connection.id && v.toolName === tool.name,
          );
          return (
            <div
              key={tool.name}
              className="flex flex-col border-b border-border last:border-0"
            >
              <div
                className="flex items-center justify-between gap-6 py-3 cursor-pointer"
                onClick={() =>
                  onTogglePin(connection.id, tool.name, connection.icon)
                }
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">
                    {tool.name}
                  </p>
                  {tool.description && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {tool.description}
                    </p>
                  )}
                </div>
                <div onClick={(e) => e.stopPropagation()} className="shrink-0">
                  <Switch
                    checked={pinned}
                    onCheckedChange={() =>
                      onTogglePin(connection.id, tool.name, connection.icon)
                    }
                    disabled={isSaving}
                  />
                </div>
              </div>
              {pinned && pinnedView && (
                <div
                  className="pb-3 pl-0 flex items-center gap-3"
                  onClick={(e) => e.stopPropagation()}
                >
                  <label className="text-xs text-muted-foreground w-12 shrink-0">
                    Label
                  </label>
                  <Input
                    value={pinnedView.label}
                    onChange={(e) =>
                      onLabelChange(connection.id, tool.name, e.target.value)
                    }
                    className="h-8 text-sm w-56"
                    disabled={isSaving}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProjectSidebarForm() {
  const { org, project } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });
  const queryClient = useQueryClient();

  const projectId = project.id ?? "";

  const virtualMcp = useVirtualMCP(projectId);

  const connections = (virtualMcp?.connections ?? []).map((c) => ({
    id: c.connection_id,
    title: c.connection_id,
    icon: null,
    connectionType: "",
    status: "active",
  }));
  const connectionIds = connections.map((c) => c.id).sort();

  // Fetch full connection details (including tools) for all connections.
  // COLLECTION_CONNECTIONS_GET now backfills tools when they're null.
  const { data: connectionsWithTools } = useQuery({
    queryKey: KEYS.projectConnectionDetails(projectId, connectionIds),
    enabled: connectionIds.length > 0,
    queryFn: async () => {
      const results = await Promise.all(
        connections.map(async (conn) => {
          try {
            const result = await client.callTool({
              name: "COLLECTION_CONNECTIONS_GET",
              arguments: { id: conn.id },
            });
            const { item } = unwrapToolResult<{
              item: {
                tools?: Array<{
                  name: string;
                  description?: string;
                  _meta?: Record<string, unknown>;
                }> | null;
              } | null;
            }>(result);
            const uiTools: UITool[] = (item?.tools ?? [])
              .filter((t) => !!getUIResourceUri(t._meta))
              .map((t) => ({ name: t.name, description: t.description }));
            return {
              id: conn.id,
              title: conn.title,
              icon: conn.icon,
              uiTools,
            };
          } catch {
            return {
              id: conn.id,
              title: conn.title,
              icon: conn.icon,
              uiTools: [],
            };
          }
        }),
      );
      return results;
    },
  });

  const connectionsData: ConnectionWithTools[] = connectionsWithTools ?? [];

  // Current pinned views from project
  const serverPinned: PinnedView[] =
    (project.ui as { pinnedViews?: PinnedView[] | null } | null)?.pinnedViews ??
    [];

  const [pinnedViews, setPinnedViews] = useState<PinnedView[]>(serverPinned);
  const [isSaving, setIsSaving] = useState(false);

  const hasChanges =
    JSON.stringify(pinnedViews) !== JSON.stringify(serverPinned);

  const handleTogglePin = (
    connectionId: string,
    toolName: string,
    connectionIcon: string | null,
  ) => {
    const pinned = pinnedViews.some(
      (v) => v.connectionId === connectionId && v.toolName === toolName,
    );
    if (pinned) {
      setPinnedViews((prev) =>
        prev.filter(
          (v) => !(v.connectionId === connectionId && v.toolName === toolName),
        ),
      );
    } else {
      setPinnedViews((prev) => [
        ...prev,
        { connectionId, toolName, label: toolName, icon: connectionIcon },
      ]);
    }
  };

  const handleLabelChange = (
    connectionId: string,
    toolName: string,
    label: string,
  ) => {
    setPinnedViews((prev) =>
      prev.map((v) =>
        v.connectionId === connectionId && v.toolName === toolName
          ? { ...v, label }
          : v,
      ),
    );
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const result = await client.callTool({
        name: "VIRTUAL_MCP_PINNED_VIEWS_UPDATE",
        arguments: { virtualMcpId: project.id, pinnedViews },
      });
      unwrapToolResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        predicate: (query) =>
          Array.isArray(query.queryKey) &&
          query.queryKey.includes("collection") &&
          query.queryKey.includes("VIRTUAL_MCP"),
      });
      toast.success("Sidebar updated");
    },
    onError: (error) => {
      toast.error(
        "Failed to update sidebar: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    },
    onSettled: () => setIsSaving(false),
  });

  const handleSave = () => {
    setIsSaving(true);
    mutation.mutate();
  };

  const handleCancel = () => {
    setPinnedViews(serverPinned);
  };

  if (connections.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4">
        No connections associated with this project. Add connections in the
        Dependencies section first.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {connectionsData.map((conn) => (
        <ConnectionToolsSection
          key={conn.id}
          connection={conn}
          pinnedViews={pinnedViews}
          isSaving={isSaving}
          onTogglePin={handleTogglePin}
          onLabelChange={handleLabelChange}
        />
      ))}

      <div className="flex items-center gap-3 pt-4">
        <Button
          variant="outline"
          onClick={handleCancel}
          disabled={!hasChanges || isSaving}
        >
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={!hasChanges || isSaving}>
          {isSaving ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}

export function ProjectSidebarPage() {
  const { project } = useProjectContext();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">Sidebar</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Pin interactive tools from your dependencies to the project sidebar
          for quick access.
        </p>
      </div>
      <ProjectSidebarForm key={project.id} />
    </div>
  );
}
