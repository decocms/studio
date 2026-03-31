import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { z } from "zod";

function isPrivateUrl(url: string): boolean {
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
      if (a === 10) return true;
      if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 127) return true;
      if (a === 169 && b === 254) return true;
      if (a === 0) return true;
    }

    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      const ipv6 = hostname.slice(1, -1).toLowerCase();
      if (ipv6 === "::1" || ipv6 === "::") return true;
      if (ipv6.startsWith("::ffff:")) return true;
      if (ipv6.startsWith("fc") || ipv6.startsWith("fd")) return true;
      if (ipv6.startsWith("fe80")) return true;
      if (ipv6.startsWith("100:")) return true;
      if (ipv6.startsWith("::1")) return true;

      const v4compat = ipv6.match(/^::(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
      if (v4compat) {
        const [, a] = v4compat.map(Number);
        if (a === 127 || a === 10 || a === 0) return true;
      }
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
      signal: controller.signal,
    });

    if (!res.ok) return null;

    const text = await res.text();
    let json: Record<string, unknown> | null = null;

    if (text.includes("event:") || text.includes("data:")) {
      const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
      if (dataLine) {
        json = JSON.parse(dataLine.slice(5).trim());
      }
    } else {
      json = JSON.parse(text);
    }

    if (!json) return null;

    const result = (json.result as Record<string, unknown>) ?? json;
    const tools = result?.tools as DiscoverTool[] | undefined;
    if (!Array.isArray(tools)) return null;

    return tools.map((t) => ({
      name: t.name,
      description: t.description ?? null,
    }));
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
    const makeTimeout = () =>
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("Connection timeout (10s)")),
          timeoutMs,
        );
      });

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
        client = new Client({ name: "registry-discover", version: "1.0.0" });

        const transport =
          attempt.transport === "sse"
            ? new SSEClientTransport(new URL(attempt.url), {
                requestInit: { headers },
              })
            : new StreamableHTTPClientTransport(new URL(attempt.url), {
                requestInit: { headers },
              });

        await Promise.race([client.connect(transport), makeTimeout()]);
        const result = await Promise.race([client.listTools(), makeTimeout()]);

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
