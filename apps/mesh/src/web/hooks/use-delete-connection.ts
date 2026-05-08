import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
  type ConnectionEntity,
} from "@decocms/mesh-sdk";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

export type DeleteConnectionState =
  | { mode: "idle" }
  | { mode: "deleting"; connection: ConnectionEntity }
  | {
      mode: "force-deleting";
      connection: ConnectionEntity;
      agentNames: string;
    };

function getMcpErrorText(result: Record<string, unknown>): string {
  const content = result.content;
  if (
    Array.isArray(content) &&
    content[0]?.type === "text" &&
    typeof content[0].text === "string"
  ) {
    return content[0].text;
  }
  return "Unknown error";
}

export function useDeleteConnection({
  onSuccess,
}: {
  onSuccess?: () => void;
} = {}) {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const [deleteState, setDeleteState] = useState<DeleteConnectionState>({
    mode: "idle",
  });

  const invalidateConnections = () => {
    queryClient.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey;
        return (
          key[1] === org.id &&
          key[3] === "collection" &&
          key[4] === "CONNECTIONS"
        );
      },
    });
  };

  const handleSuccess = () => {
    invalidateConnections();
    toast.success("Connection deleted successfully");
    setDeleteState({ mode: "idle" });
    onSuccess?.();
  };

  const requestDelete = (connection: ConnectionEntity) => {
    setDeleteState({ mode: "deleting", connection });
  };

  const cancelDelete = () => {
    setDeleteState({ mode: "idle" });
  };

  const confirmDelete = async () => {
    if (deleteState.mode !== "deleting") return;

    const connection = deleteState.connection;
    setDeleteState({ mode: "idle" });

    try {
      const result = await selfClient.callTool({
        name: "COLLECTION_CONNECTIONS_DELETE",
        arguments: { id: connection.id },
      });

      if (result.isError) {
        const errorText = getMcpErrorText(result);

        const jsonText = errorText.replace(/^Error:\s*/, "");
        try {
          const parsed = JSON.parse(jsonText) as {
            code?: string;
            agentNames?: string[];
          };
          if (parsed.code === "CONNECTION_IN_USE" && parsed.agentNames) {
            setDeleteState({
              mode: "force-deleting",
              connection,
              agentNames: parsed.agentNames.map((n) => `"${n}"`).join(", "),
            });
            return;
          }
        } catch {
          // Not JSON — fall through to generic error toast
        }

        toast.error(`Failed to delete connection: ${errorText}`);
        return;
      }

      handleSuccess();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Failed to delete connection: ${message}`);
    }
  };

  const confirmForceDelete = async () => {
    if (deleteState.mode !== "force-deleting") return;

    const id = deleteState.connection.id;
    setDeleteState({ mode: "idle" });

    try {
      const result = await selfClient.callTool({
        name: "COLLECTION_CONNECTIONS_DELETE",
        arguments: { id, force: true },
      });

      if (result.isError) {
        toast.error(`Failed to delete connection: ${getMcpErrorText(result)}`);
        return;
      }

      handleSuccess();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Failed to delete connection: ${message}`);
    }
  };

  return {
    deleteState,
    requestDelete,
    cancelDelete,
    confirmDelete,
    confirmForceDelete,
  };
}
