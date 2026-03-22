import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "../context";
import { KEYS } from "../lib/query-keys";
import { SELF_MCP_ALIAS_ID } from "../lib/constants";
import { useMCPClient } from "./use-mcp-client";

export interface ConnectionInstallInput {
  title: string;
  connection_url: string;
  description?: string;
  icon?: string;
  app_name?: string;
  app_id?: string;
  connection_type?: "HTTP" | "SSE" | "Websocket";
  id?: string;
  connection_token?: string;
  connection_headers?: Record<string, unknown>;
  oauth_config?: Record<string, unknown>;
  configuration_state?: Record<string, unknown>;
  configuration_scopes?: string[];
  metadata?: Record<string, unknown>;
}

export interface ConnectionInstallOutput {
  connection_id: string;
  title: string;
  icon: string | null;
  connection_url: string | null;
  status: string;
  needs_auth: boolean;
  is_existing: boolean;
  message: string;
}

function extractPayload<T>(result: unknown): T {
  if (!result || typeof result !== "object") {
    throw new Error("Invalid result");
  }

  if ("isError" in result && result.isError) {
    throw new Error(
      "content" in result &&
        Array.isArray(result.content) &&
        result.content[0]?.type === "text"
        ? result.content[0].text
        : "Unknown error",
    );
  }

  if ("structuredContent" in result) {
    return result.structuredContent as T;
  }

  throw new Error("No structured content found");
}

export function useConnectionInstall() {
  const { org, locator } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      input: ConnectionInstallInput,
    ): Promise<ConnectionInstallOutput> => {
      const result = await client.callTool({
        name: "CONNECTION_INSTALL",
        arguments: input as unknown as Record<string, unknown>,
      });
      return extractPayload<ConnectionInstallOutput>(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: KEYS.connections(locator),
      });
    },
  });
}
