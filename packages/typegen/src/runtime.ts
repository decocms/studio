import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { MeshClient, MeshClientOptions, ToolMap } from "./index.js";

const DEFAULT_BASE_URL = "https://mesh-admin.decocms.com";

/** @internal - overrideable constructors for testing */
export interface MeshClientDeps {
  Client: typeof Client;
  Transport: typeof StreamableHTTPClientTransport;
}

export function createMeshClient<T extends ToolMap>(
  opts: MeshClientOptions,
  /** @internal */ _deps?: Partial<MeshClientDeps>,
): MeshClient<T> {
  const ClientCtor = _deps?.Client ?? Client;
  const TransportCtor = _deps?.Transport ?? StreamableHTTPClientTransport;

  // Shared promise prevents concurrent calls from creating multiple connections
  let connectPromise: Promise<Client> | null = null;

  function getClient(): Promise<Client> {
    if (connectPromise) return connectPromise;

    connectPromise = (async () => {
      const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
      const apiKey = opts.apiKey ?? process.env.MESH_API_KEY;
      // Build URL with string concat so a path-prefixed baseUrl is preserved,
      // and encode mcpId to guard against special characters in the ID.
      const url = new URL(
        `${base}/mcp/virtual-mcp/${encodeURIComponent(opts.mcpId)}`,
      );

      const client = new ClientCtor({
        name: "@decocms/typegen",
        version: "1.0.0",
      });
      await client.connect(
        new TransportCtor(url, {
          requestInit: {
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          },
        }),
      );

      return client;
    })();

    return connectPromise;
  }

  return new Proxy({} as MeshClient<T>, {
    get(_target, toolName: string) {
      if (toolName === "close") {
        return async () => {
          if (connectPromise) {
            const client = await connectPromise;
            await client.close();
            connectPromise = null;
          }
        };
      }

      return async (input: unknown) => {
        const client = await getClient();
        const result = await client.callTool({
          name: toolName,
          arguments: input as Record<string, unknown>,
        });

        if (result.isError) {
          const message = Array.isArray(result.content)
            ? result.content.map((c) => ("text" in c ? c.text : "")).join(" ")
            : "Tool call failed";
          throw new Error(message);
        }

        return result.structuredContent;
      };
    },
  });
}
