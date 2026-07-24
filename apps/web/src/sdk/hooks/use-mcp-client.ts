import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { useSuspenseQuery } from "@tanstack/react-query";
import { SELF_MCP_ALIAS_ID } from "@decocms/shared/sdk/lib/constants";
import { KEYS } from "@/lib/query-keys";
import { createRestSelfClient } from "../lib/rest-self-client";
import { resolveStudioUrl } from "../lib/studio-url";
import { StreamableHTTPClientTransport } from "../lib/streamable-http-client-transport";

const DEFAULT_CLIENT_INFO = {
  name: "studio-sdk",
  version: "1.0.0",
};

export interface CreateMcpClientOptions {
  /** Connection ID - use SELF_MCP_ALIAS_ID for the self/management MCP (builtin tools), or any connectionId for other MCPs */
  connectionId: string | null;
  /** Organization ID - required for query-key scoping */
  orgId: string;
  /** Organization slug - required, used to build the /api/:org/mcp URL */
  orgSlug: string;
  /** Authorization token - optional */
  token?: string | null;
  /** Studio server URL - optional, defaults to window.location.origin (for external apps, provide your Studio server URL) */
  studioUrl?: string;
  /** @deprecated Use `studioUrl` instead. */
  meshUrl?: string;
  /**
   * Absolute MCP endpoint URL override. When set, the client connects directly
   * to this URL instead of the org-scoped `/api/:org/mcp/:connectionId` route.
   * Used to reach a co-located sandbox dev server straight from the browser
   * (loopback `http://<handle>.localhost/api/mcp`), bypassing the cloud proxy —
   * which cannot reach a desktop sandbox's loopback. Never the self/REST client.
   */
  mcpUrl?: string;
}

export type UseMcpClientOptions = CreateMcpClientOptions;

export interface UseMcpClientOptionalOptions
  extends Omit<CreateMcpClientOptions, "connectionId"> {
  /** Connection ID - string for connection MCP, null for default/self, undefined to skip (returns null) */
  connectionId: string | null | undefined;
}

/**
 * Build the MCP URL from connectionId and optional Studio URL.
 * Uses /api/:org/mcp/:connectionId for all servers (org-scoped routing).
 */
function buildMcpUrl(
  connectionId: string | null,
  orgSlug: string,
  studioUrl?: string,
): string {
  const baseUrl =
    studioUrl ??
    (typeof window !== "undefined" ? window.location.origin : undefined);
  if (!baseUrl) {
    throw new Error(
      "MCP client requires either studioUrl or a browser environment.",
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
  studioUrl,
  meshUrl,
  mcpUrl,
}: CreateMcpClientOptions): Promise<Client> {
  const studioServerUrl = resolveStudioUrl({ studioUrl, meshUrl });
  const queryKey = KEYS.mcpClient(
    orgId,
    connectionId ?? "self",
    token ?? "",
    mcpUrl ?? studioServerUrl ?? "",
  );

  // Self/management connection → REST-backed client. The browser no longer
  // speaks MCP to the Studio server for builtin tools; they're called over plain
  // REST (`/api/:org/tools/:name`). The MCP SDK stays for outbound connections.
  // A direct `mcpUrl` override is never the self client (it targets a dev server).
  if (!mcpUrl && (!connectionId || connectionId === SELF_MCP_ALIAS_ID)) {
    return createRestSelfClient({
      orgSlug,
      token,
      studioUrl: studioServerUrl,
      toJSONString: `mcp-client:${queryKey.join(":")}`,
    });
  }

  const url = mcpUrl ?? buildMcpUrl(connectionId, orgSlug, studioServerUrl);

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
  (client as Client & { toJSON: () => string }).toJSON = () =>
    `mcp-client:${queryKey.join(":")}`;

  return client;
}

/**
 * React Query options for an MCP client connection. Single source of truth for
 * the client query key + connect behavior, so a suspense consumer
 * (`useMCPClient`) and a non-suspense pre-warm (e.g. the shell starting the self
 * connection in parallel with the rest of bootstrap) target the EXACT same
 * cache entry — the key cannot drift between them.
 */
export function mcpClientQueryOptions(options: UseMcpClientOptions) {
  const { connectionId, token, studioUrl, meshUrl, mcpUrl, orgId } = options;
  const studioServerUrl = resolveStudioUrl({ studioUrl, meshUrl });
  return {
    queryKey: KEYS.mcpClient(
      orgId,
      connectionId ?? "self",
      token ?? "",
      mcpUrl ?? studioServerUrl ?? "",
    ),
    queryFn: () => createMCPClient(options),
    staleTime: Infinity, // Keep client alive while query is active
    // Keep the client cached for a minute after the last subscriber detaches so
    // brief unmount/remount transitions (sidebar collapse toggle, popover open,
    // etc.) re-use the same transport instead of re-establishing it.
    gcTime: 60_000,
  };
}

/**
 * Hook to create and manage an MCP client with Streamable HTTP transport.
 * Uses Suspense - must be used within a Suspense boundary.
 *
 * @param options - Configuration for the MCP client
 * @returns The MCP client instance (never null - suspends until ready)
 */
export function useMCPClient(options: UseMcpClientOptions): Client {
  const { data: client } = useSuspenseQuery(mcpClientQueryOptions(options));
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
  studioUrl,
  meshUrl,
  mcpUrl,
}: UseMcpClientOptionalOptions): Client | null {
  const studioServerUrl = resolveStudioUrl({ studioUrl, meshUrl });
  const queryKey =
    connectionId !== undefined
      ? KEYS.mcpClient(
          orgId,
          connectionId ?? "self",
          token ?? "",
          mcpUrl ?? studioServerUrl ?? "",
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
        studioUrl: studioServerUrl,
        mcpUrl,
      });
    },
    staleTime: Infinity,
    // Match the non-optional variant — see useMCPClient for the rationale.
    gcTime: 60_000,
  });

  return client ?? null;
}
