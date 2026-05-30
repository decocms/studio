/**
 * Eager-handshake gating for the MCP proxy.
 *
 * The proxy eagerly opens the downstream MCP connection before handling a
 * request so that upstream auth errors (e.g. OAuth 401) surface for methods the
 * proxy would otherwise answer locally — chiefly `initialize`, which the proxy
 * responds to with its own capabilities and never touches downstream.
 *
 * That probe is a full MCP handshake (initialize + initialized). Running it for
 * every request defeats the NATS list cache: a `tools/list` poll served from
 * cache would still pay a downstream handshake. But the probe is also the only
 * place a 401 surfaces as an HTTP `WWW-Authenticate` response (errors thrown
 * inside `transport.handleRequest` become JSON-RPC error bodies, not the 401 the
 * frontend popup needs). So we can't blindly skip it for list methods either.
 *
 * The resolution: skip the probe for a list method only when its list is
 * already cached (the warm stale-while-revalidate path). On a cold cache we
 * still probe — that both surfaces first-load auth errors and warms the
 * per-request pool for the lazy list call. See proxy.ts for the cache check.
 */

import type { McpListType } from "@/mcp-clients/mcp-list-cache";

/** Whether/when to eagerly open the downstream connection for a request. */
export type ProbeDecision =
  | "probe" // always probe (initialize, tools/call, reads, unknown)
  | "skip" // never probe (notifications, ping, GET/DELETE, unparseable)
  | "skip-if-list-cached"; // probe only on a cold list cache

/** List methods the lazy client serves from the NATS list cache, mapped to the
 * cache type the proxy must check before deciding to skip the probe. */
const LIST_METHOD_CACHE_TYPE: Record<string, McpListType> = {
  "tools/list": "tools",
  "resources/list": "resources",
  "prompts/list": "prompts",
};

/** Methods the proxy answers locally with no downstream interaction at all. */
const LOCAL_ONLY_METHODS = new Set(["ping"]);

/**
 * Decide whether to eagerly open the downstream connection for a JSON-RPC
 * method. Pure — the cold/warm list-cache lookup happens in proxy.ts.
 */
export function probeDecision(method: string | undefined): {
  decision: ProbeDecision;
  listType?: McpListType;
} {
  if (!method) return { decision: "skip" };
  if (method.startsWith("notifications/")) return { decision: "skip" };
  if (LOCAL_ONLY_METHODS.has(method)) return { decision: "skip" };

  const listType = LIST_METHOD_CACHE_TYPE[method];
  if (listType) return { decision: "skip-if-list-cached", listType };

  return { decision: "probe" };
}

// Initialize and list payloads are tiny; anything larger is definitely a
// tool call or content write whose method we don't need to inspect. Skipping
// the parse avoids buffering large bodies twice (clone + handleRequest).
const MAX_PEEK_BYTES = 64_000;

/**
 * Read the JSON-RPC method from a request body without consuming the original
 * stream — clones first so `transport.handleRequest` can still read it.
 *
 * Returns `undefined` for non-POST requests (GET SSE / DELETE), oversized
 * bodies, or unparseable JSON. Batch requests report the first member's method
 * (a batch containing `initialize` is invalid per spec, so this is safe).
 */
export async function peekRpcMethod(req: Request): Promise<string | undefined> {
  if (req.method !== "POST") return undefined;

  const contentLength = req.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_PEEK_BYTES) {
    return undefined;
  }

  try {
    const body = await req.clone().json();
    const first = Array.isArray(body) ? body[0] : body;
    const method = (first as { method?: unknown } | null)?.method;
    return typeof method === "string" ? method : undefined;
  } catch {
    return undefined;
  }
}
