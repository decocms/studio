import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { VirtualClient } from "./sandbox";
import {
  MAX_RESULT_TOKENS,
  createOutputPreview,
  estimateJsonTokens,
} from "./read-tool-output";

/**
 * Normalize MCP prompt content to text-safe representations.
 * Replaces image/audio blobs and embedded resources with placeholders
 * to avoid dumping base64 into the model context.
 */
function normalizePromptContent(
  content: { type: string; [key: string]: unknown } | string,
): string {
  if (typeof content === "string") return content;

  if (content.type === "text" && typeof content.text === "string") {
    return content.text;
  }
  if (content.type === "image") {
    const mime = (content.mimeType as string) ?? "image/*";
    return `[image: ${mime}]`;
  }
  if (content.type === "audio") {
    const mime = (content.mimeType as string) ?? "audio/*";
    return `[audio: ${mime}]`;
  }
  if (content.type === "resource") {
    const res = content.resource as
      | { uri?: string; text?: string; mimeType?: string }
      | undefined;
    if (res?.text) return res.text;
    return `[embedded resource: ${res?.uri ?? "unknown"}]`;
  }
  return JSON.stringify(content);
}

export interface PromptToolParams {
  readonly passthroughClient: VirtualClient;
  readonly toolOutputMap: Map<string, string>;
}

export function createReadPromptTool(params: PromptToolParams) {
  const { passthroughClient, toolOutputMap } = params;
  return tool({
    description:
      "Read a prompt by name from <available_prompts>. " +
      "Returns the prompt messages with action-oriented guide content. " +
      "Use this to load step-by-step instructions for common tasks.",
    inputSchema: zodSchema(
      z.object({
        name: z
          .string()
          .min(1)
          .describe("The name of the prompt from <available_prompts>."),
        arguments: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Optional arguments for the prompt, as key-value string pairs.",
          ),
      }),
    ),
    execute: async ({ name, arguments: args }) => {
      const result = await passthroughClient.getPrompt({
        name,
        arguments: args,
      });
      const messages = result.messages;

      if (!messages || messages.length === 0) {
        return { result: "Prompt returned no content." };
      }

      const parts = messages.map((m) => ({
        role: m.role,
        content: normalizePromptContent(m.content),
      }));

      const serialized = JSON.stringify(parts, null, 2);
      const tokens = estimateJsonTokens(serialized);

      if (tokens > MAX_RESULT_TOKENS) {
        const toolCallId = `prompt_${Date.now()}`;
        toolOutputMap.set(toolCallId, serialized);
        const preview = createOutputPreview(serialized);
        return {
          result: `Prompt content too large (${tokens} tokens). Use read_tool_output with tool_call_id "${toolCallId}" to extract specific data.\n\nPreview:\n${preview}`,
        };
      }

      return { messages: parts };
    },
  });
}
