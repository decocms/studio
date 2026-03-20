/**
 * Hooks for Context Repo feature
 *
 * Uses CONTEXT_REPO_STATUS tool to get both gh CLI status
 * and current context repo config in a single call.
 */

import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";

interface GhStatus {
  available: boolean;
  user?: string;
}

interface ContextRepoConfig {
  connectionId: string;
  owner: string;
  repo: string;
  branch: string;
  lastSyncedCommit: string | null;
  fileCount: number;
  indexSizeBytes: number;
  lastSyncedAt: string | null;
  indexedFolders: string[] | null;
  folders: Array<{ name: string; fileCount: number; totalBytes: number }>;
}

interface ContextRepoStatus {
  gh: GhStatus;
  contextRepo: ContextRepoConfig | null;
}

function extractToolResult(result: unknown): unknown {
  const content = (
    result as { content?: Array<{ type: string; text?: string }> }
  )?.content;
  const text = content?.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

/**
 * Get context repo status: gh CLI auth + current config.
 * Single call to CONTEXT_REPO_STATUS tool.
 */
export function useContextRepo(): {
  gh: GhStatus;
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
        name: "CONTEXT_REPO_STATUS",
        arguments: {},
      });
      return extractToolResult(result) as ContextRepoStatus;
    },
    staleTime: 30_000,
  });

  return {
    gh: data?.gh ?? { available: false },
    config: data?.contextRepo ?? null,
    isLoading,
  };
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
 * Update which folders are indexed
 */
export function useContextRepoUpdateFolders() {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  return useMutation({
    mutationFn: async (folders: string[]) => {
      return await client.callTool({
        name: "CONTEXT_REPO_UPDATE_FOLDERS",
        arguments: { folders },
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
    mutationFn: async () => {
      await client.callTool({
        name: "CONTEXT_REPO_DISCONNECT",
        arguments: {},
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries();
    },
  });
}
