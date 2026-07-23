/**
 * REST-backed client for the self/management connection.
 *
 * The web client no longer speaks MCP to the Studio server for builtin tools —
 * it calls them over plain REST at `POST /api/:org/tools/:name`. This object
 * implements the subset of the MCP `Client` interface the app actually uses
 * against the self connection (`callTool`, `listTools`), returning the same
 * `CallToolResult`/`ListToolsResult` shapes so existing generic hooks
 * (`use-collections`, `use-mcp-tools`, …) and call sites work unchanged.
 *
 * The MCP SDK is reserved for outbound connections; nothing here imports it at
 * runtime. Prompts/resources are not used against self in the web, so those
 * methods throw a clear error if ever called.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { resolveStudioUrl } from "./studio-url";

export interface RestSelfClientOptions {
  /** Organization slug, used to build `/api/:org/tools/...`. */
  orgSlug: string;
  /** Bearer token for non-cookie auth (external apps). Browser uses the session cookie. */
  token?: string | null;
  /** Studio server origin; defaults to `window.location.origin` in the browser. */
  studioUrl?: string;
  /** @deprecated Use `studioUrl` instead. */
  meshUrl?: string;
  /** Stable string used for React Query key serialization (via `toJSON`). */
  toJSONString: string;
}

interface CallToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

const text = (value: string) => [{ type: "text" as const, text: value }];

export function createRestSelfClient(opts: RestSelfClientOptions): Client {
  const origin = resolveStudioUrl(
    opts,
    typeof window !== "undefined" ? window.location.origin : undefined,
  );
  if (!origin) {
    throw new Error(
      "RestSelfClient requires either studioUrl or a browser environment.",
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
  };

  const toUrl = (path: string) =>
    new URL(`/api/${encodeURIComponent(opts.orgSlug)}${path}`, origin).href;

  const callTool = async (params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<CallToolResult> => {
    let res: Response;
    try {
      res = await fetch(toUrl(`/tools/${encodeURIComponent(params.name)}`), {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify(params.arguments ?? {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error";
      return { content: text(message), isError: true };
    }

    if (!res.ok) {
      let message = `${params.name} failed (${res.status})`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) message = body.error;
      } catch {
        // non-JSON error body — keep the default message
      }
      return { content: text(message), isError: true };
    }

    const result = await res.json().catch(() => ({}));
    return {
      content: text(
        typeof result === "string" ? result : JSON.stringify(result),
      ),
      structuredContent: result,
    };
  };

  const listTools = async () => {
    const res = await fetch(toUrl(`/tools`), {
      method: "GET",
      headers,
      credentials: "include",
    });
    if (!res.ok) return { tools: [] };
    return (await res.json()) as { tools: unknown[] };
  };

  const unsupported = (method: string) => () => {
    return Promise.reject(
      new Error(
        `RestSelfClient: ${method} is not supported over REST for the self connection`,
      ),
    );
  };

  const client = {
    callTool,
    listTools,
    listPrompts: unsupported("listPrompts"),
    getPrompt: unsupported("getPrompt"),
    listResources: unsupported("listResources"),
    readResource: unsupported("readResource"),
    listResourceTemplates: unsupported("listResourceTemplates"),
    close: () => Promise.resolve(),
    toJSON: () => opts.toJSONString,
  };

  return client as unknown as Client;
}
