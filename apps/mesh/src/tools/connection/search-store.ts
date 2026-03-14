/**
 * CONNECTION_SEARCH_STORE Tool
 *
 * Search the Deco Store and Community Registry for MCPs by query.
 * Uses direct HTTP JSON-RPC calls to well-known registry URLs to avoid
 * proxy setup issues and schema validation errors.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireOrganization } from "../../core/mesh-context";

const StoreResultSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  connection_url: z.string(),
  app_name: z.string().nullable(),
  app_id: z.string().nullable(),
  source: z.string().describe("Which registry this result came from"),
});

type StoreResult = z.infer<typeof StoreResultSchema>;

// Well-known registry URLs (hardcoded — these never change)
const REGISTRIES = [
  {
    name: "Deco Store",
    url: "https://studio.decocms.com/org/deco/registry/mcp",
  },
  {
    name: "Community Registry",
    url: "https://sites-registry.decocache.com/mcp",
  },
];

let nextRpcId = 1;

/**
 * Make a raw JSON-RPC call to an MCP server.
 * Bypasses proxy setup, schema validation, and connection DB lookups.
 */
async function mcpRpc(
  url: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextRpcId++,
      method,
      params: params ?? {},
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const body = await response.json();
  if (body.error) {
    throw new Error(body.error.message || "RPC error");
  }
  return body.result;
}

/**
 * Search a registry by first discovering its tools, then calling the search/list tool.
 */
async function searchRegistry(
  url: string,
  query: string,
  limit: number,
  source: string,
): Promise<StoreResult[]> {
  // Step 1: Initialize (required by MCP protocol)
  await mcpRpc(url, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mesh-store-search", version: "1.0.0" },
  });

  // Step 2: Discover tools
  const listResult = (await mcpRpc(url, "tools/list")) as {
    tools?: Array<{ name: string }>;
  };
  const tools = listResult?.tools ?? [];

  // Find the best search/list tool
  const searchTool =
    tools.find((t) => t.name.toLowerCase().includes("search")) ??
    tools.find((t) => t.name.toLowerCase().includes("list"));

  if (!searchTool) {
    return [];
  }

  // Step 3: Call the search tool
  // Use `where` filter for collection-style tools, `query` for search-style
  const isCollectionTool = searchTool.name.startsWith("COLLECTION_");
  const args = isCollectionTool
    ? {
        where: {
          field: ["title"],
          operator: "contains",
          value: query,
        },
        limit,
      }
    : { query, limit };

  const callResult = (await mcpRpc(url, "tools/call", {
    name: searchTool.name,
    arguments: args,
  })) as {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
  };

  // Try structured content first (bypasses schema validation on our side),
  // then fall back to text content
  let items: Record<string, unknown>[] = [];

  if (callResult?.structuredContent) {
    const sc = callResult.structuredContent;
    items = Array.isArray(sc)
      ? sc
      : Array.isArray(sc.items)
        ? (sc.items as Record<string, unknown>[])
        : Array.isArray(sc.data)
          ? (sc.data as Record<string, unknown>[])
          : [];
  } else if (callResult?.content?.length) {
    const textContent = callResult.content.find((c) => c.type === "text");
    if (textContent?.text) {
      try {
        const parsed = JSON.parse(textContent.text);
        items = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed.items)
            ? parsed.items
            : Array.isArray(parsed.data)
              ? parsed.data
              : [];
      } catch {
        // Invalid JSON
      }
    }
  }

  return items
    .slice(0, limit)
    .map(
      (item): StoreResult => ({
        title: String(
          item.title || item.name || item.app_name || "Unknown MCP",
        ),
        description: item.description ? String(item.description) : null,
        icon: item.icon ? String(item.icon) : null,
        connection_url: String(
          item.connection_url || item.url || item.mcp_url || "",
        ),
        app_name: item.app_name ? String(item.app_name) : null,
        app_id: item.app_id ? String(item.app_id) : null,
        source,
      }),
    )
    .filter((r) => r.connection_url);
}

export const CONNECTION_SEARCH_STORE = defineTool({
  name: "CONNECTION_SEARCH_STORE",
  description:
    "Search the Deco Store and Community Registry for available MCPs to install",
  annotations: {
    title: "Search MCP Store",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({
    query: z.string().describe("Search query (e.g. 'gmail', 'slack', 'email')"),
    limit: z
      .number()
      .optional()
      .default(10)
      .describe("Max results per registry. Defaults to 10."),
  }),
  outputSchema: z.object({
    results: z.array(StoreResultSchema),
    query: z.string(),
  }),

  handler: async (input, ctx) => {
    requireOrganization(ctx);
    await ctx.access.check();

    const results: StoreResult[] = [];

    // Search all registries in parallel via direct HTTP
    const searchPromises = REGISTRIES.map(async (registry) => {
      try {
        const url = registry.url;
        return await searchRegistry(
          url,
          input.query,
          input.limit,
          registry.name,
        );
      } catch (error) {
        console.warn(
          `[search-store] Failed to search ${registry.name}:`,
          error instanceof Error ? error.message : error,
        );
        return [];
      }
    });

    const searchResults = await Promise.allSettled(searchPromises);
    for (const result of searchResults) {
      if (result.status === "fulfilled") {
        results.push(...result.value);
      }
    }

    // Deduplicate by connection_url
    const seen = new Set<string>();
    const deduplicated = results.filter((r) => {
      if (seen.has(r.connection_url)) return false;
      seen.add(r.connection_url);
      return true;
    });

    return {
      results: deduplicated,
      query: input.query,
    };
  },
});
