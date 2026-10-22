import {
  UI_RESOURCE_HTML_KEY,
  useProjectContext,
  type ConnectionEntity,
} from "@/sdk";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { clearHtmlResourceCacheForConnection } from "@/lib/html-resource-persist";
import { useStudioTools } from "@/lib/studio-tools";
import { invalidateConnectionsCollection } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t";

export type DeleteConnectionState =
  | { mode: "idle" }
  | { mode: "deleting"; connection: ConnectionEntity }
  | {
      mode: "force-deleting";
      connection: ConnectionEntity;
      agentNames: string;
    };

export function useDeleteConnection({
  onSuccess,
}: {
  onSuccess?: () => void;
} = {}) {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const studio = useStudioTools();
  const t = useT();

  const [deleteState, setDeleteState] = useState<DeleteConnectionState>({
    mode: "idle",
  });

  const invalidateConnections = () => {
    invalidateConnectionsCollection(queryClient, org.id);
  };

  const evictUiResourceCache = (connectionId: string) => {
    void clearHtmlResourceCacheForConnection(connectionId);
    queryClient.invalidateQueries({
      predicate: (query) =>
        query.queryKey[1] === UI_RESOURCE_HTML_KEY &&
        query.queryKey[3] === connectionId,
    });
  };

  const handleSuccess = (connectionId: string) => {
    invalidateConnections();
    evictUiResourceCache(connectionId);
    toast.success(t("orgs.connections.connectionDeleted"));
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
      await studio.call("COLLECTION_CONNECTIONS_DELETE", {
        id: connection.id,
      });

      handleSuccess(connection.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      const jsonText = message.replace(/^Error:\s*/, "");
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

      toast.error(
        t("orgs.connections.failedToDeleteConnection", { error: message }),
      );
    }
  };

  const confirmForceDelete = async () => {
    if (deleteState.mode !== "force-deleting") return;

    const id = deleteState.connection.id;
    setDeleteState({ mode: "idle" });

    try {
      await studio.call("COLLECTION_CONNECTIONS_DELETE", { id, force: true });

      handleSuccess(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(
        t("orgs.connections.failedToDeleteConnection", { error: message }),
      );
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
