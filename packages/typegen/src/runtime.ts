import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { discoverEndpoint, withMcpId } from "./endpoint.js";
import type { StudioClient, StudioClientOptions, ToolMap } from "./index.js";

const DEFAULT_BASE_URL = "https://studio.decocms.com";

/**
 * Resolve where to connect and with what headers. Precedence:
 * 1. `opts.endpoint` — an explicit pre-authenticated endpoint.
 * 2. `mcpId` + an api key (opts or env) — the classic id-based path.
 * 3. A discovered sandbox endpoint file (`.deco/tools/.endpoint.json`),
 *    retargeted to `mcpId` when one was given.
 * Resolved inside `getClient` (not at construction) so a reconnect after
 * `close()` re-reads a refreshed endpoint file.
 */
function resolveTarget(opts: StudioClientOptions): {
  url: URL;
  headers: Record<string, string>;
} {
  if (opts.endpoint) {
    return {
      url: new URL(opts.endpoint.url),
      headers: opts.endpoint.headers ?? {},
    };
  }
  const apiKey =
    opts.apiKey ?? process.env.STUDIO_API_KEY ?? process.env.MESH_API_KEY;
  if (opts.mcpId && (apiKey || opts.baseUrl)) {
    const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    // Build URL with string concat so a path-prefixed baseUrl is preserved,
    // and encode mcpId to guard against special characters in the ID.
    return {
      url: new URL(`${base}/mcp/virtual-mcp/${encodeURIComponent(opts.mcpId)}`),
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    };
  }
  const discovered = discoverEndpoint();
  if (discovered) {
    return {
      url: new URL(
        opts.mcpId ? withMcpId(discovered.url, opts.mcpId) : discovered.url,
      ),
      headers: discovered.headers ?? {},
    };
  }
  if (!opts.mcpId) {
    throw new Error(
      "createStudioClient: no target — pass mcpId (with an api key), an endpoint, or run inside a sandbox with .deco/tools/.endpoint.json",
    );
  }
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  return {
    url: new URL(`${base}/mcp/virtual-mcp/${encodeURIComponent(opts.mcpId)}`),
    headers: {},
  };
}

/** @internal - overrideable constructors for testing */
export interface StudioClientDeps {
  Client: typeof Client;
  Transport: typeof StreamableHTTPClientTransport;
}

/** @deprecated Use `StudioClientDeps`. */
export type MeshClientDeps = StudioClientDeps;

export function createStudioClient<T extends ToolMap = ToolMap>(
  opts: StudioClientOptions = {},
  /** @internal */ _deps?: Partial<StudioClientDeps>,
): StudioClient<T> {
  const ClientCtor = _deps?.Client ?? Client;
  const TransportCtor = _deps?.Transport ?? StreamableHTTPClientTransport;

  // Shared promise prevents concurrent calls from creating multiple connections
  let connectPromise: Promise<Client> | null = null;

  function getClient(): Promise<Client> {
    if (connectPromise) return connectPromise;

    connectPromise = (async () => {
      const { url, headers } = resolveTarget(opts);
      const client = new ClientCtor({
        name: "@decocms/typegen",
        version: "1.0.0",
      });
      await client.connect(
        new TransportCtor(url, { requestInit: { headers } }),
      );

      return client;
    })();

    // A failed connect must not be cached forever — clear it so the next
    // call retries instead of replaying the same rejection indefinitely.
    connectPromise.catch(() => {
      connectPromise = null;
    });

    return connectPromise;
  }

  return new Proxy({} as StudioClient<T>, {
    get(_target, toolName: string) {
      // Without this, `await createStudioClient(...)` treats the proxy as a
      // thenable (since `.then` resolves to a function), calls it as
      // `then(resolve, reject)`, and — since that call is really a tool
      // invocation that never touches `resolve`/`reject` — the await hangs
      // forever instead of resolving to the client.
      if (toolName === "then") return undefined;
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
          const text = Array.isArray(result.content)
            ? result.content
                .map((c) => ("text" in c ? c.text : ""))
                .filter(Boolean)
                .join(" ")
            : "";
          throw new Error(
            `Tool "${toolName}" failed${text ? `: ${text}` : ""}`,
          );
        }

        return result.structuredContent;
      };
    },
  });
}

/** @deprecated Use `createStudioClient`. */
export function createMeshClient<T extends ToolMap = ToolMap>(
  opts: StudioClientOptions = {},
  /** @internal */ deps?: Partial<StudioClientDeps>,
): StudioClient<T> {
  return createStudioClient<T>(opts, deps);
}
