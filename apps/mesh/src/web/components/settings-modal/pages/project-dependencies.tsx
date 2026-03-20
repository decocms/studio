import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@deco/ui/components/command.tsx";
import { toast } from "sonner";
import { cn } from "@deco/ui/lib/utils.ts";
import { Plus, X } from "@untitledui/icons";
import {
  useProjectContext,
  useMCPClient,
  useConnections,
  SELF_MCP_ALIAS_ID,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import { unwrapToolResult } from "@/web/lib/unwrap-tool-result";

function ConnectionIcon({
  icon,
  title,
}: {
  icon: string | null;
  title: string;
}) {
  if (icon) {
    return <img src={icon} alt="" className="size-5 shrink-0 rounded" />;
  }
  return (
    <div className="size-5 shrink-0 rounded bg-muted flex items-center justify-center">
      <span className="text-[10px] font-medium text-muted-foreground">
        {title.charAt(0).toUpperCase()}
      </span>
    </div>
  );
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
  const [popoverOpen, setPopoverOpen] = useState(false);

  const { data: virtualMcpData } = useQuery({
    queryKey: KEYS.projectConnections(projectId),
    enabled: !!project.id,
    queryFn: async () => {
      const result = await client.callTool({
        name: "COLLECTION_VIRTUAL_MCP_GET",
        arguments: { id: projectId },
      });
      return unwrapToolResult<{
        item: {
          connections: Array<{ connection_id: string }>;
        } | null;
      }>(result);
    },
  });

  const associatedIds = new Set(
    (virtualMcpData?.item?.connections ?? []).map((c) => c.connection_id),
  );

  const associatedConnections = (allConnections ?? []).filter((c) =>
    associatedIds.has(c.id),
  );
  const availableConnections = (allConnections ?? []).filter(
    (c) => !associatedIds.has(c.id),
  );

  const invalidateQueries = () => {
    queryClient.invalidateQueries({
      queryKey: KEYS.projectConnections(projectId),
    });
    queryClient.invalidateQueries({
      queryKey: KEYS.project(org.id, project.slug),
    });
  };

  const addMutation = useMutation({
    mutationFn: async (connectionId: string) => {
      // Get current connections and add the new one
      const currentConnections = (virtualMcpData?.item?.connections ?? []).map(
        (c) => ({ connection_id: c.connection_id }),
      );
      const result = await client.callTool({
        name: "COLLECTION_VIRTUAL_MCP_UPDATE",
        arguments: {
          id: project.id,
          data: {
            connections: [
              ...currentConnections,
              { connection_id: connectionId },
            ],
          },
        },
      });
      unwrapToolResult(result);
    },
    onSuccess: () => invalidateQueries(),
    onError: (error) => {
      toast.error(
        "Failed to add connection: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (connectionId: string) => {
      // Get current connections and remove the specified one
      const currentConnections = (
        virtualMcpData?.item?.connections ?? []
      ).filter((c) => c.connection_id !== connectionId);
      const result = await client.callTool({
        name: "COLLECTION_VIRTUAL_MCP_UPDATE",
        arguments: {
          id: project.id,
          data: {
            connections: currentConnections.map((c) => ({
              connection_id: c.connection_id,
            })),
          },
        },
      });
      unwrapToolResult(result);
    },
    onSuccess: () => invalidateQueries(),
    onError: (error) => {
      toast.error(
        "Failed to remove connection: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    },
  });

  const handleAdd = (connectionId: string) => {
    setPopoverOpen(false);
    addMutation.mutate(connectionId);
  };

  const handleRemove = (connectionId: string) => {
    removeMutation.mutate(connectionId);
  };

  return (
    <div className="space-y-4">
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5">
            <Plus size={14} />
            Add connection
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search connections..." />
            <CommandList>
              <CommandEmpty>No connections found.</CommandEmpty>
              <CommandGroup>
                {availableConnections.map((conn) => (
                  <CommandItem
                    key={conn.id}
                    value={conn.title}
                    onSelect={() => handleAdd(conn.id)}
                  >
                    <ConnectionIcon icon={conn.icon} title={conn.title} />
                    <span className="truncate">{conn.title}</span>
                    <span
                      className={cn(
                        "ml-auto inline-block size-1.5 shrink-0 rounded-full",
                        conn.status === "active"
                          ? "bg-success"
                          : conn.status === "error"
                            ? "bg-destructive"
                            : "bg-muted-foreground",
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {associatedConnections.length > 0 && (
        <div className="flex flex-col">
          {associatedConnections.map((conn) => (
            <div
              key={conn.id}
              className="flex items-center justify-between gap-4 py-3 border-b border-border last:border-0"
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <ConnectionIcon icon={conn.icon} title={conn.title} />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">
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
              <button
                type="button"
                onClick={() => handleRemove(conn.id)}
                disabled={removeMutation.isPending}
                className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {associatedConnections.length === 0 && (
        <p className="text-sm text-muted-foreground py-4">
          No connections added yet. Add connections from the organization to
          make them available in this project.
        </p>
      )}
    </div>
  );
}

export function ProjectDependenciesPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">Connections</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Choose which organization connections are available to this project.
        </p>
      </div>
      <ProjectDependenciesForm />
    </div>
  );
}
