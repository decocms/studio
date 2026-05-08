import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { useSuspenseQuery } from "@tanstack/react-query";
import { KEYS } from "../lib/query-keys";
import { StreamableHTTPClientTransport } from "../lib/streamable-http-client-transport";

const DEFAULT_CLIENT_INFO = {
  name: "mesh-sdk",
  version: "1.0.0",
};

export interface CreateMcpClientOptions {
  /** Connection ID - use SELF_MCP_ALIAS_ID for the self/management MCP (ALL_TOOLS), or any connectionId for other MCPs */
  connectionId: string | null;
  /** Organization ID - required for query-key scoping */
  orgId: string;
  /** Organization slug - required, used to build the /api/:org/mcp URL */
  orgSlug: string;
  /** Authorization token - optional */
  token?: string | null;
  /** Mesh server URL - optional, defaults to window.location.origin (for external apps, provide your Mesh server URL) */
  meshUrl?: string;
}

export type UseMcpClientOptions = CreateMcpClientOptions;

export interface UseMcpClientOptionalOptions
  extends Omit<CreateMcpClientOptions, "connectionId"> {
  /** Connection ID - string for connection MCP, null for default/self, undefined to skip (returns null) */
  connectionId: string | null | undefined;
}

/**
 * Build the MCP URL from connectionId and optional meshUrl.
 * Uses /api/:org/mcp/:connectionId for all servers (org-scoped routing).
 */
function buildMcpUrl(
  connectionId: string | null,
  orgSlug: string,
  meshUrl?: string,
): string {
  const baseUrl =
    meshUrl ??
    (typeof window !== "undefined" ? window.location.origin : undefined);
  if (!baseUrl) {
    throw new Error(
      "MCP client requires either meshUrl option or a browser environment.",
    );
  }

  const orgPath = `/api/${encodeURIComponent(orgSlug)}`;
  const path = connectionId
    ? `${orgPath}/mcp/${connectionId}`
    : `${orgPath}/mcp`;
  return new URL(path, baseUrl).href;
}

/**
 * Create and connect an MCP client with Streamable HTTP transport.
 * This is the low-level function for creating clients outside of React hooks.
 *
 * @param options - Configuration for the MCP client
 * @returns Promise resolving to the connected MCP client
 */
export async function createMCPClient({
  connectionId,
  orgId,
  orgSlug,
  token,
  meshUrl,
}: CreateMcpClientOptions): Promise<Client> {
  const url = buildMcpUrl(connectionId, orgSlug, meshUrl);

  const client = new Client(DEFAULT_CLIENT_INFO, {
    capabilities: {
      tasks: {
        list: {},
        cancel: {},
        requests: {
          tool: {
            call: {},
          },
        },
      },
    },
  });

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    },
  });

  await client.connect(transport);

  // Add toJSON method for query key serialization
  // This allows the client to be used directly in query keys
  const queryKey = KEYS.mcpClient(
    orgId,
    connectionId ?? "self",
    token ?? "",
    meshUrl ?? "",
  );

  (client as Client & { toJSON: () => string }).toJSON = () =>
    `mcp-client:${queryKey.join(":")}`;

  return client;
}

/**
 * Hook to create and manage an MCP client with Streamable HTTP transport.
 * Uses Suspense - must be used within a Suspense boundary.
 *
 * @param options - Configuration for the MCP client
 * @returns The MCP client instance (never null - suspends until ready)
 */
export function useMCPClient({
  connectionId,
  orgId,
  orgSlug,
  token,
  meshUrl,
}: UseMcpClientOptions): Client {
  const queryKey = KEYS.mcpClient(
    orgId,
    connectionId ?? "self",
    token ?? "",
    meshUrl ?? "",
  );

  const { data: client } = useSuspenseQuery({
    queryKey,
    queryFn: () =>
      createMCPClient({ connectionId, orgId, orgSlug, token, meshUrl }),
    staleTime: Infinity, // Keep client alive while query is active
    gcTime: 0, // Clean up immediately when query is inactive
  });

  return client!;
}

/**
 * Optional MCP client - returns null when connectionId is undefined (skip creating client).
 * Use when the connection may not be selected yet (e.g. model picker with no connections).
 *
 * - connectionId: string → connection-specific MCP
 * - connectionId: null → default/self MCP
 * - connectionId: undefined → skip (returns null, no MCP call)
 *
 * @param options - Configuration for the MCP client
 * @returns The MCP client instance, or null when connectionId is undefined
 */
export function useMCPClientOptional({
  connectionId,
  orgId,
  orgSlug,
  token,
  meshUrl,
}: UseMcpClientOptionalOptions): Client | null {
  const queryKey =
    connectionId !== undefined
      ? KEYS.mcpClient(
          orgId,
          connectionId ?? "self",
          token ?? "",
          meshUrl ?? "",
        )
      : (["mcp", "client", "skip", orgId] as const);

  const { data: client } = useSuspenseQuery({
    queryKey,
    queryFn: async () => {
      if (connectionId === undefined) {
        return null;
      }
      return createMCPClient({
        connectionId: connectionId as string | null,
        orgId,
        orgSlug,
        token,
        meshUrl,
      });
    },
    staleTime: Infinity,
    gcTime: 0,
  });

  return client ?? null;
}
