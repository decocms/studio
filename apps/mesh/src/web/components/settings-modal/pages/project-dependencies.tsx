import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@deco/ui/components/switch.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { toast } from "sonner";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  useProjectContext,
  useMCPClient,
  useConnections,
  SELF_MCP_ALIAS_ID,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import { unwrapToolResult } from "@/web/lib/unwrap-tool-result";

interface ConnectionListResult {
  connections: Array<{
    id: string;
    title: string;
    icon: string | null;
    connectionType: string;
    status: string;
  }>;
}

function ProjectDependenciesForm() {
  const { org, project } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });
  const queryClient = useQueryClient();
  const allConnections = useConnections();
  const projectId = project.id ?? "";

  const { data: projectConnections } = useQuery({
    queryKey: KEYS.projectConnections(projectId),
    queryFn: async () => {
      const result = await client.callTool({
        name: "PROJECT_CONNECTION_LIST",
        arguments: { projectId: project.id },
      });
      return unwrapToolResult<ConnectionListResult>(result);
    },
  });

  const associatedIds = new Set(
    (projectConnections?.connections ?? []).map((c) => c.id),
  );

  const [pendingChanges, setPendingChanges] = useState<Record<string, boolean>>(
    {},
  );
  const [isSaving, setIsSaving] = useState(false);

  const isAssociated = (connId: string): boolean => {
    if (pendingChanges[connId] !== undefined) return pendingChanges[connId];
    return associatedIds.has(connId);
  };

  const hasChanges = Object.keys(pendingChanges).length > 0;

  const handleToggle = (connId: string, enabled: boolean) => {
    const serverState = associatedIds.has(connId);
    if (enabled === serverState) {
      setPendingChanges((prev) => {
        const next = { ...prev };
        delete next[connId];
        return next;
      });
    } else {
      setPendingChanges((prev) => ({ ...prev, [connId]: enabled }));
    }
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const adds = Object.entries(pendingChanges)
        .filter(([, enabled]) => enabled)
        .map(([connId]) => connId);
      const removes = Object.entries(pendingChanges)
        .filter(([, enabled]) => !enabled)
        .map(([connId]) => connId);

      const results = await Promise.all([
        ...adds.map((connectionId) =>
          client.callTool({
            name: "PROJECT_CONNECTION_ADD",
            arguments: { projectId: project.id, connectionId },
          }),
        ),
        ...removes.map((connectionId) =>
          client.callTool({
            name: "PROJECT_CONNECTION_REMOVE",
            arguments: { projectId: project.id, connectionId },
          }),
        ),
      ]);
      for (const result of results) {
        unwrapToolResult(result);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: KEYS.projectConnections(projectId),
      });
      queryClient.invalidateQueries({
        queryKey: KEYS.project(org.id, project.slug),
      });
      setPendingChanges({});
      toast.success("Dependencies updated");
    },
    onError: (error) => {
      toast.error(
        "Failed to update dependencies: " +
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
    setPendingChanges({});
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col">
        {(allConnections ?? []).map((conn) => (
          <div
            key={conn.id}
            className="flex items-center justify-between gap-6 py-4 border-b border-border last:border-0 cursor-pointer"
            onClick={() =>
              !isSaving && handleToggle(conn.id, !isAssociated(conn.id))
            }
          >
            <div className="flex items-start gap-3 min-w-0 flex-1">
              {conn.icon ? (
                <img
                  src={conn.icon}
                  alt=""
                  className="size-5 shrink-0 rounded mt-0.5"
                />
              ) : (
                <div className="size-5 shrink-0 rounded bg-muted flex items-center justify-center mt-0.5">
                  <span className="text-[10px] font-medium text-muted-foreground">
                    {conn.title.charAt(0).toUpperCase()}
                  </span>
                </div>
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {conn.title}
                </p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-muted-foreground">
                    {conn.connection_type}
                  </span>
                  <span
                    className={cn(
                      "inline-block size-1.5 rounded-full",
                      conn.status === "active"
                        ? "bg-success"
                        : conn.status === "error"
                          ? "bg-destructive"
                          : "bg-muted-foreground",
                    )}
                  />
                </div>
              </div>
            </div>
            <div onClick={(e) => e.stopPropagation()} className="shrink-0">
              <Switch
                checked={isAssociated(conn.id)}
                onCheckedChange={(checked) => handleToggle(conn.id, checked)}
                disabled={isSaving}
              />
            </div>
          </div>
        ))}
        {(allConnections ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground py-4">
            No connections available. Create connections in the organization
            first.
          </p>
        )}
      </div>

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

export function ProjectDependenciesPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Dependencies
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Select which connections from the organization are available to this
          project.
        </p>
      </div>
      <ProjectDependenciesForm />
    </div>
  );
}
