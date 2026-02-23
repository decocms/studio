/**
 * Hook to read/write the .deco/preview.json config via the local-dev connection.
 * Uses read_file/write_file MCP tools.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { KEYS } from "../lib/query-keys";

export interface PreviewConfig {
  command: string;
  port: number;
}

const CONFIG_PATH = ".deco/preview.json";

/**
 * Reads .deco/preview.json from the local-dev connection.
 */
export function usePreviewConfig(
  client: Client | null,
  connectionId: string | null,
) {
  return useQuery({
    queryKey: KEYS.previewConfig(connectionId ?? ""),
    queryFn: async (): Promise<PreviewConfig | null> => {
      if (!client) return null;
      try {
        const result = (await client.callTool({
          name: "read_file",
          arguments: { path: CONFIG_PATH },
        })) as { content?: Array<{ type?: string; text?: string }> };

        // callTool returns { content: [{ type: "text", text: "..." }] }
        const text = result.content?.[0]?.text;
        if (!text) return null;
        return JSON.parse(text) as PreviewConfig;
      } catch {
        // File doesn't exist yet
        return null;
      }
    },
    enabled: !!client && !!connectionId,
    staleTime: 30_000,
    refetchInterval: (query) => {
      // Poll while no config exists (AI might be writing it)
      return query.state.data === null ? 5_000 : false;
    },
  });
}

/**
 * Writes .deco/preview.json to the local-dev connection.
 */
export function useWritePreviewConfig(
  client: Client | null,
  connectionId: string | null,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (config: PreviewConfig) => {
      if (!client) throw new Error("MCP client not available");
      await client.callTool({
        name: "write_file",
        arguments: {
          path: CONFIG_PATH,
          content: JSON.stringify(config, null, 2),
        },
      });
      return config;
    },
    onSuccess: (config) => {
      queryClient.setQueryData(KEYS.previewConfig(connectionId ?? ""), config);
    },
  });
}
