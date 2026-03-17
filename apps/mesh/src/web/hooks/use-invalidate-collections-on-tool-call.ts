/**
 * Hook to invalidate collection queries when tool calls occur in chat
 *
 * This hook returns an onToolCall handler that can be passed to usePersistedChat.
 * When a collection CRUD tool is called (CREATE/UPDATE/DELETE), it invalidates
 * the relevant collection queries so the UI refreshes automatically.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { toast } from "sonner";
import { KEYS } from "../lib/query-keys";
import { useProjectContext } from "@decocms/mesh-sdk";

/**
 * Hook that returns an onToolCall handler for invalidating collection queries
 *
 * @returns A function compatible with useChat's onToolCall callback
 */
export function useInvalidateCollectionsOnToolCall() {
  const queryClient = useQueryClient();
  const { org } = useProjectContext();
  const params = useParams({ strict: false });

  return (event: { toolCall: { toolName: string } }) => {
    const toolName = event.toolCall.toolName;

    // Match <NAME>_(CREATE|UPDATE|DELETE) pattern
    const match = toolName.match(/^([A-Z_]+)_(CREATE|UPDATE|DELETE)$/);
    if (!match || !match[1]) {
      return; // Not a collection CRUD tool
    }

    const collectionName = match[1]; // e.g., "ASSISTANT", "WORKFLOW", etc.

    // Try to extract connectionId from URL params
    // Matches routes like /:org/mcps/:connectionId or /:org/mcps/:connectionId/:collectionName/:itemId
    const connectionId = params.connectionId;

    if (!connectionId) {
      // No connectionId in URL, can't invalidate
      return;
    }

    // Invalidate all queries for this collection using the base prefix
    // This will invalidate both list and item queries
    queryClient.invalidateQueries({
      queryKey: KEYS.collection(org.slug, connectionId, collectionName),
    });

    // Notify user that collection was updated
    const formattedCollectionName = collectionName
      .toLowerCase()
      .replace(/_/g, " ");
    toast.success(`${formattedCollectionName} updated`);
  };
}
