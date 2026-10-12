/**
 * CONNECTION_TOOLS_SEARCH / CONNECTION_TOOL_CALL
 *
 * One entry point to every connection a run may use, instead of mounting each
 * as its own MCP server. Claude Code announces every mounted tool by name on
 * the first turn, so an org with ~90 connections paid ~200k prompt tokens per
 * request before doing anything. Here the model sees two tools, searches by
 * name and description, and calls what it found through the same authorized
 * proxy client the per-connection endpoint uses.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MCP_LIST_TOOLS_TIMEOUT_MS } from "../../core/constants";
import { defineTool } from "../../core/define-tool";
import {
  requireOrganization,
  type StudioContext,
} from "../../core/studio-context";
import { clientFromConnection, listToolsWithTimeout } from "../../mcp-clients";
import {
  fetchWithCache,
  getMcpListCache,
  REVALIDATE_MIN_INTERVAL_MS,
} from "../../mcp-clients/mcp-list-cache";
import { mapWithConcurrency } from "./map-with-concurrency";
import type { ConnectionEntity } from "./schema";

const LIST_CONCURRENCY = 8;
const DESCRIPTION_CHARS = 400;

/**
 * The connections the caller may reach. A run's key names them itself (one
 * entry per granted connection next to `self`), so the search never offers a
 * connection the call would be refused on. A session has no map; it sees the
 * org's connections and the proxy still authorizes each call.
 */
async function reachableConnections(
  ctx: StudioContext,
  organizationId: string,
): Promise<ConnectionEntity[]> {
  const { items } = await ctx.storage.connections.list(organizationId);
  const permissions =
    ctx.auth.permissionsOrganizationId === organizationId
      ? ctx.auth.permissions
      : undefined;
  return items.filter(
    (connection) =>
      connection.status === "active" &&
      (!permissions || connection.id in permissions),
  );
}

async function toolsOf(
  ctx: StudioContext,
  connection: ConnectionEntity,
): Promise<Tool[]> {
  if (connection.tools) return connection.tools as Tool[];
  const tools = await fetchWithCache(
    "tools",
    connection.id,
    () => listToolsWithTimeout(connection, ctx, MCP_LIST_TOOLS_TIMEOUT_MS),
    getMcpListCache(),
    (p) => ctx.pendingRevalidations.push(p),
    REVALIDATE_MIN_INTERVAL_MS,
  ).catch(() => null);
  return (tools as Tool[] | null) ?? [];
}

/** Lowercased words of two or more characters; `_` and `-` split words. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);
}

export interface SearchHit {
  name: string;
  description: string;
  inputSchema?: unknown;
  connections: { id: string; title: string }[];
  score: number;
}

/**
 * Rank tools against a query: a word in the tool name counts most, then the
 * connection title, then the description. The same tool offered by several
 * connections (the same MCP connected several times) is one hit listing all of them.
 * Pure — the unit test owns the ranking.
 */
export function rankTools(
  query: string,
  catalog: { connection: { id: string; title: string }; tools: Tool[] }[],
  limit: number,
  withSchema: boolean,
): SearchHit[] {
  const terms = words(query);
  const hits = new Map<string, SearchHit>();
  for (const { connection, tools } of catalog) {
    const title = connection.title.toLowerCase();
    for (const tool of tools) {
      const name = words(tool.name).join(" ");
      const description = (tool.description ?? "").toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (name.includes(term)) score += 3;
        if (title.includes(term)) score += 2;
        if (description.includes(term)) score += 1;
      }
      if (score === 0) continue;
      const key = `${tool.name}\n${tool.description ?? ""}`;
      const hit = hits.get(key);
      if (hit) {
        hit.connections.push(connection);
        hit.score = Math.max(hit.score, score);
        continue;
      }
      hits.set(key, {
        name: tool.name,
        description: (tool.description ?? "").slice(0, DESCRIPTION_CHARS),
        ...(withSchema ? { inputSchema: tool.inputSchema } : {}),
        connections: [connection],
        score,
      });
    }
  }
  return [...hits.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export const CONNECTION_TOOLS_SEARCH = defineTool({
  name: "CONNECTION_TOOLS_SEARCH",
  description:
    "Search the tools of every connection you can use (GitHub, Slack, VTEX, " +
    "Linear, ...) by keywords. Returns tool names, descriptions and the " +
    "connections that offer them. Set withSchema to get the input schema " +
    "before calling one with CONNECTION_TOOL_CALL.",
  annotations: {
    title: "Search Connection Tools",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .describe("Keywords, e.g. 'github pull request search'"),
    limit: z.number().int().min(1).max(25).default(8),
    withSchema: z
      .boolean()
      .default(false)
      .describe("Include each tool's input schema"),
  }),
  outputSchema: z.object({
    tools: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        inputSchema: z.unknown().optional(),
        connections: z.array(z.object({ id: z.string(), title: z.string() })),
      }),
    ),
  }),
  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const connections = await reachableConnections(ctx, organization.id);
    const catalog: {
      connection: { id: string; title: string };
      tools: Tool[];
    }[] = [];
    await mapWithConcurrency(connections, LIST_CONCURRENCY, async (c) => {
      catalog.push({
        connection: { id: c.id, title: c.title },
        tools: await toolsOf(ctx, c),
      });
    });
    const hits = rankTools(input.query, catalog, input.limit, input.withSchema);
    return { tools: hits.map(({ score: _score, ...hit }) => hit) };
  },
});

export const CONNECTION_TOOL_CALL = defineTool({
  name: "CONNECTION_TOOL_CALL",
  description:
    "Call a tool on one of your connections. Find the tool, its connection id " +
    "and its input schema with CONNECTION_TOOLS_SEARCH first.",
  annotations: {
    title: "Call Connection Tool",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: z.object({
    connectionId: z.string(),
    toolName: z.string(),
    arguments: z.record(z.string(), z.unknown()).default({}),
  }),
  outputSchema: z.object({
    content: z.array(z.unknown()),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().optional(),
  }),
  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const connection = (await reachableConnections(ctx, organization.id)).find(
      (c) => c.id === input.connectionId,
    );
    if (!connection) {
      throw new Error(`Connection not found: ${input.connectionId}`);
    }
    // Not super-user: the proxy authorizes `{ <connectionId>: [toolName] }`.
    const client = await clientFromConnection(connection, ctx, false);
    const result = await client.callTool({
      name: input.toolName,
      arguments: input.arguments,
    });
    return {
      content: Array.isArray(result.content) ? result.content : [],
      ...(result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {}),
      ...(typeof result.isError === "boolean"
        ? { isError: result.isError }
        : {}),
    };
  },
});
