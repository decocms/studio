import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { VirtualClient } from "./sandbox";
import {
  MAX_RESULT_TOKENS,
  createOutputPreview,
  estimateJsonTokens,
} from "./read-tool-output";

export interface ResourceToolParams {
  readonly passthroughClient: VirtualClient;
  readonly toolOutputMap: Map<string, string>;
}

export function createReadResourceTool(params: ResourceToolParams) {
  const { passthroughClient, toolOutputMap } = params;
  return tool({
    description:
      "Read a resource by its URI. Returns the content of the resource.",
    inputSchema: zodSchema(
      z.object({
        uri: z.string().min(1).describe("The URI of the resource to read."),
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
