import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { VirtualClient } from "./sandbox";
import {
  MAX_RESULT_TOKENS,
  createOutputPreview,
  estimateJsonTokens,
} from "./read-tool-output";

const DEFAULT_PAGE_SIZE = 50;

export interface ResourceToolParams {
  readonly passthroughClient: VirtualClient;
  readonly toolOutputMap: Map<string, string>;
}

export function createListResourcesTool(params: ResourceToolParams) {
  const { passthroughClient } = params;
  return tool({
    description:
      "List available resources from the connected MCP servers. " +
      "Resources are data sources like files, database records, or API responses that can be read by URI. " +
      "Supports cursor-based pagination — pass the nextCursor from a previous response to fetch the next page.",
    inputSchema: zodSchema(
      z.object({
        cursor: z
          .string()
          .optional()
          .describe(
            "Pagination cursor returned as nextCursor from a previous call. Omit for the first page.",
          ),
      }),
    ),
    execute: async ({ cursor }) => {
      const result = await passthroughClient.listResources();
      const all = result.resources;

      const offset = cursor ? parseInt(cursor, 10) : 0;
      if (cursor && (isNaN(offset) || offset < 0)) {
        return { error: "Invalid cursor" };
      }

      const page = all.slice(offset, offset + DEFAULT_PAGE_SIZE);
      const nextOffset = offset + DEFAULT_PAGE_SIZE;

      return {
        resources: page.map((r) => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        })),
        nextCursor: nextOffset < all.length ? String(nextOffset) : undefined,
        total: all.length,
      };
    },
  });
}

export function createReadResourceTool(params: ResourceToolParams) {
  const { passthroughClient, toolOutputMap } = params;
  return tool({
    description:
      "Read a resource by its URI. Returns the content of the resource. " +
      "Use list_resources first to discover available resource URIs.",
    inputSchema: zodSchema(
      z.object({
        uri: z
          .string()
          .min(1)
          .describe(
            "The URI of the resource to read, as returned by list_resources.",
          ),
      }),
    ),
    execute: async ({ uri }) => {
      const result = await passthroughClient.readResource({ uri });
      const contents = result.contents;

      if (!contents || contents.length === 0) {
        return { result: "Resource returned no content." };
      }

      const parts = contents.map((c) => {
        if ("text" in c && c.text !== undefined) {
          return { uri: c.uri, mimeType: c.mimeType, text: c.text };
        }
        if ("blob" in c && c.blob !== undefined) {
          return {
            uri: c.uri,
            mimeType: c.mimeType,
            blob: `[binary data, ${c.blob.length} bytes base64]`,
          };
        }
        return { uri: c.uri, mimeType: c.mimeType };
      });

      const serialized = JSON.stringify(parts, null, 2);
      const tokens = estimateJsonTokens(serialized);

      if (tokens > MAX_RESULT_TOKENS) {
        const toolCallId = `resource_${Date.now()}`;
        toolOutputMap.set(toolCallId, serialized);
        const preview = createOutputPreview(serialized);
        return {
          result: `Resource content too large (${tokens} tokens). Use read_tool_output with tool_call_id "${toolCallId}" to extract specific data.\n\nPreview:\n${preview}`,
        };
      }

      return { contents: parts };
    },
  });
}
