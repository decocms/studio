import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/studio-context";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { sharedJsonSchemaValidator } from "@decocms/mcp-utils";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { z } from "zod";

/** RFC 1918 / loopback / link-local ranges, keyed off the first two IPv4 octets. */
function isPrivateIPv4Octets(a: number, b: number | undefined): boolean {
  if (a === 10) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  // RFC 6598 Shared Address Space (100.64.0.0/10) — CGNAT range also used by
  // cloud providers for internal service/metadata endpoints (e.g. Alibaba
  // Cloud's 100.100.100.200 metadata server).
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
  return false;
}

/** Decode the first IPv6 hex word (16 bits) into the first two IPv4 octets. */
function hexWordToIPv4(word: string): [number, number] {
  const value = Number.parseInt(word.padStart(4, "0"), 16);
  return [value >> 8, value & 0xff];
}

/**
 * IPv6 transition mechanisms (6to4, NAT64) embed a literal IPv4 address in the
 * hostname. A private IPv4 embedded this way must be blocked the same as the
 * plain dotted form, or it bypasses the SSRF guard below.
 */
function isPrivateEmbeddedIPv4(ipv6: string): boolean {
  const groups = ipv6.split(":").filter((g) => g.length > 0);

  // 6to4: 2002:WWXX:YYZZ:... — embedded IPv4's first two octets are word WWXX.
  if (ipv6.startsWith("2002:") && groups.length >= 2) {
    const [a, b] = hexWordToIPv4(groups[1]!);
    if (isPrivateIPv4Octets(a, b)) return true;
  }

  // NAT64: 64:ff9b::WWXX:YYZZ — embedded IPv4's first two octets are the
  // second-to-last word (well-known /96 prefix, IPv4 in the last 32 bits).
  if (ipv6.startsWith("64:ff9b::") && groups.length >= 4) {
    const [a, b] = hexWordToIPv4(groups[groups.length - 2]!);
    if (isPrivateIPv4Octets(a, b)) return true;
  }

  // IPv4-compatible IPv6 (deprecated, RFC 4291): dotted ::a.b.c.d input is
  // always normalized by `new URL()` into compressed hex (e.g. ::127.0.0.1
  // becomes ::7f00:1) before we ever see the hostname, so it collapses to
  // exactly "::" + 2 hex words — same shape as the 6to4 case above.
  if (ipv6.startsWith("::") && groups.length === 2) {
    const [a, b] = hexWordToIPv4(groups[0]!);
    if (isPrivateIPv4Octets(a, b)) return true;
  }

  return false;
}

export function isPrivateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    if (
      hostname === "localhost" ||
      hostname === "0.0.0.0" ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".localhost")
    ) {
      return true;
    }

    const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4Match) {
      const [, a, b] = ipv4Match.map(Number);
      if (isPrivateIPv4Octets(a!, b)) return true;
    }

    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      const ipv6 = hostname.slice(1, -1).toLowerCase();
      if (ipv6 === "::1" || ipv6 === "::") return true;
      if (ipv6.startsWith("::ffff:")) return true;
      if (ipv6.startsWith("fc") || ipv6.startsWith("fd")) return true;
      if (ipv6.startsWith("fe80")) return true;
      if (ipv6.startsWith("100:")) return true;
      if (ipv6.startsWith("::1")) return true;
      if (isPrivateEmbeddedIPv4(ipv6)) return true;
    }

    return false;
  } catch {
    return true;
  }
}

const DiscoverToolsInputSchema = z.object({
  url: z.string().describe("Remote MCP server URL"),
  type: z
    .enum(["http", "sse"])
    .optional()
    .default("http")
    .describe("Transport type"),
});

const DiscoverToolsOutputSchema = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().nullable().optional(),
    }),
  ),
  error: z.string().nullable().optional(),
});

function getUrlVariants(url: string): string[] {
  const variants = [url];
  if (url.startsWith("http://")) {
    variants.push(url.replace("http://", "https://"));
  } else if (url.startsWith("https://")) {
    variants.push(url.replace("https://", "http://"));
  }
  return variants;
}

type TransportType = "http" | "sse";

interface ConnectAttempt {
  url: string;
  transport: TransportType;
}

interface DiscoverTool {
  name: string;
  description?: string | null;
}

const RawDiscoverToolSchema = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
});

function isAuthRequiredError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("unauthorized") ||
    lower.includes("authentication required") ||
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes('"code":-32000')
  );
}

/**
 * Parse a raw `tools/list` JSON-RPC response body (plain JSON or SSE-framed)
 * into a validated tool list. Unlike the MCP SDK client path, this fallback
 * talks to the server over a bare `fetch`, so nothing validates the shape of
 * the remote server's response until this function does — a malformed or
 * malicious `name`/`description` here would otherwise flow straight into the
 * UI (rendered as a React child, used as a list key).
 */
export function parseToolsListResponse(text: string): DiscoverTool[] | null {
  let json: Record<string, unknown> | null = null;

  try {
    if (text.includes("event:") || text.includes("data:")) {
      const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
      if (dataLine) {
        json = JSON.parse(dataLine.slice(5).trim());
      }
    } else {
      json = JSON.parse(text);
    }
  } catch {
    return null;
  }

  if (!json) return null;

  const result = (json.result as Record<string, unknown>) ?? json;
  const parsed = z.array(RawDiscoverToolSchema).safeParse(result?.tools);
  if (!parsed.success) return null;

  return parsed.data.map((t) => ({
    name: t.name,
    description: t.description ?? null,
  }));
}

/**
 * Race a promise against a timeout, clearing the timer either way. A bare
 * `Promise.race([p, new Promise((_, reject) => setTimeout(reject, ms))])`
 * leaves that setTimeout running after `p` wins the race — it fires later
 * as an unhandled rejection (nothing is still awaiting it).
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function tryRawToolsList(
  url: string,
  timeoutMs: number,
): Promise<DiscoverTool[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
      // `isPrivateUrl` only vets the URL we're about to fetch — a remote
      // server could otherwise 3xx-redirect this request to an internal
      // address (e.g. the cloud metadata endpoint) and bypass that check
      // entirely, since fetch follows redirects by default.
      redirect: "manual",
      signal: controller.signal,
    });

    if (!res.ok) return null;

    const text = await res.text();
    return parseToolsListResponse(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const REGISTRY_DISCOVER_TOOLS = defineTool({
  name: "REGISTRY_DISCOVER_TOOLS" as const,
  description:
    "Discover tools from a remote MCP server by connecting to it server-side (no CORS issues).",
  inputSchema: DiscoverToolsInputSchema,
  outputSchema: DiscoverToolsOutputSchema,

  handler: async (input, ctx) => {
    requireOrganization(ctx);
    await ctx.access.check();
    const { url, type } = input;

    if (!url) {
      return { tools: [], error: "URL is required" };
    }

    if (isPrivateUrl(url)) {
      return {
        tools: [],
        error: "URLs targeting private networks are not allowed",
      };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };

    const timeoutMs = 10_000;

    const urlVariants = getUrlVariants(url);
    const transportTypes: TransportType[] =
      type === "sse" ? ["sse", "http"] : ["http", "sse"];

    const attempts: ConnectAttempt[] = [];
    for (const u of urlVariants) {
      for (const t of transportTypes) {
        attempts.push({ url: u, transport: t });
      }
    }

    let lastError: string | null = null;
    let authErrorUrl: string | null = null;

    for (const attempt of attempts) {
      let client: Client | null = null;
      try {
        client = new Client(
          { name: "registry-discover", version: "1.0.0" },
          { jsonSchemaValidator: sharedJsonSchemaValidator },
        );

        const transport =
          attempt.transport === "sse"
            ? new SSEClientTransport(new URL(attempt.url), {
                requestInit: { headers },
              })
            : new StreamableHTTPClientTransport(new URL(attempt.url), {
                requestInit: { headers },
              });

        await withTimeout(
          client.connect(transport),
          timeoutMs,
          "Connection timeout (10s)",
        );
        const result = await withTimeout(
          client.listTools(),
          timeoutMs,
          "Connection timeout (10s)",
        );

        const tools = (result.tools || []).map(
          (t: { name: string; description?: string | null }) => ({
            name: t.name,
            description: t.description ?? null,
          }),
        );

        console.log(
          `[REGISTRY_DISCOVER_TOOLS] Success via ${attempt.transport} ${attempt.url}: ${tools.length} tools`,
        );
        return { tools, error: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[REGISTRY_DISCOVER_TOOLS] ${attempt.transport} ${attempt.url}: ${message}`,
        );
        lastError = message;

        if (isAuthRequiredError(message) && !authErrorUrl) {
          authErrorUrl = attempt.url;
        }
      } finally {
        try {
          await client?.close();
        } catch {
          // ignore
        }
      }
    }

    if (authErrorUrl) {
      console.log(
        `[REGISTRY_DISCOVER_TOOLS] Auth required, trying raw tools/list on ${authErrorUrl}...`,
      );

      for (const rawUrl of urlVariants) {
        const rawTools = await tryRawToolsList(rawUrl, timeoutMs);
        if (rawTools && rawTools.length > 0) {
          console.log(
            `[REGISTRY_DISCOVER_TOOLS] Raw tools/list on ${rawUrl}: ${rawTools.length} tools`,
          );
          return { tools: rawTools, error: null };
        }
      }

      return {
        tools: [],
        error:
          "Server requires authentication. Tools cannot be discovered without credentials, but the connection is valid.",
      };
    }

    console.error(
      `[REGISTRY_DISCOVER_TOOLS] All attempts failed for ${url}: ${lastError}`,
    );
    return { tools: [], error: lastError };
  },
});
