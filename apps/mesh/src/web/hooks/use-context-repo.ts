/**
 * Hooks for Context Repo feature
 *
 * Finds the GITHUB context repo connection and provides
 * setup/sync mutations via MCP tool calls.
 */

import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
  type ConnectionEntity,
} from "@decocms/mesh-sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";

interface ContextRepoConfig {
  connectionId: string;
  owner: string;
  repo: string;
  branch: string;
  lastSyncedCommit: string | null;
  fileCount: number;
  indexSizeBytes: number;
  lastSyncedAt: string | null;
}

/**
 * Find the GITHUB context repo connection for this org.
 * Calls COLLECTION_CONNECTIONS_LIST with include_virtual=true to include GITHUB connections.
 */
export function useContextRepo(): {
  config: ContextRepoConfig | null;
  isLoading: boolean;
} {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const { data, isLoading } = useQuery({
    queryKey: KEYS.contextRepo(org.id),
    queryFn: async () => {
      const result = await client.callTool({
        name: "COLLECTION_CONNECTIONS_LIST",
        arguments: { include_virtual: true },
      });
      const content = result?.content as Array<{
        type: string;
        text?: string;
      }>;
      const text = content?.find((c) => c.type === "text")?.text;
      if (!text) return null;
      const payload = JSON.parse(text) as { items?: ConnectionEntity[] };
      const connections = payload.items ?? [];

      for (const conn of connections) {
        if (conn.connection_type !== "GITHUB") continue;
        const metadata = conn.metadata as Record<string, unknown> | null;
        if (!metadata || metadata.type !== "context-repo") continue;
        return {
          connectionId: conn.id,
          owner: metadata.owner as string,
          repo: metadata.repo as string,
          branch: (metadata.branch as string) || "main",
          lastSyncedCommit: (metadata.lastSyncedCommit as string) || null,
          fileCount: (metadata.fileCount as number) || 0,
          indexSizeBytes: (metadata.indexSizeBytes as number) || 0,
          lastSyncedAt: (metadata.lastSyncedAt as string) || null,
        };
      }
      return null;
    },
    staleTime: 30_000,
  });

  return { config: data ?? null, isLoading };
}

/**
 * Setup a new context repo
 */
export function useContextRepoSetup() {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  return useMutation({
    mutationFn: async (input: {
      owner: string;
      repo: string;
      branch?: string;
    }) => {
      return await client.callTool({
        name: "CONTEXT_REPO_SETUP",
        arguments: input,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries();
    },
  });
}

/**
 * Sync the context repo (pull + reindex)
 */
export function useContextRepoSync() {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  return useMutation({
    mutationFn: async () => {
      return await client.callTool({
        name: "CONTEXT_REPO_SYNC",
        arguments: {},
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries();
    },
  });
}

/**
 * Disconnect context repo (delete the GITHUB connection)
 */
export function useContextRepoDisconnect() {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  return useMutation({
    mutationFn: async (connectionId: string) => {
      await client.callTool({
        name: "COLLECTION_CONNECTIONS_DELETE",
        arguments: { id: connectionId },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries();
    },
  });
}
