import { tool, zodSchema } from "ai";
import { z } from "zod";
import { runCode } from "@decocms/mcp-utils/sandbox";
import type {
  CallToolRequest,
  GetPromptRequest,
  GetPromptResult,
  ListPromptsResult,
  ListResourcesResult,
  ListToolsResult,
  ReadResourceRequest,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  MAX_RESULT_TOKENS,
  createOutputPreview,
  estimateJsonTokens,
} from "./read-tool-output";

export interface VirtualClient {
  listTools(): Promise<ListToolsResult>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  callTool(params: CallToolRequest["params"]): Promise<any>;
  listResources(): Promise<ListResourcesResult>;
  readResource(
    params: ReadResourceRequest["params"],
  ): Promise<ReadResourceResult>;
  listPrompts(): Promise<ListPromptsResult>;
  getPrompt(params: GetPromptRequest["params"]): Promise<GetPromptResult>;
}

export interface SandboxToolParams {
  readonly passthroughClient: VirtualClient;
  readonly toolOutputMap: Map<string, string>;
  readonly needsApproval: boolean;
}

export function createSandboxTool(params: SandboxToolParams) {
  const { passthroughClient, toolOutputMap, needsApproval } = params;
  return tool({
    needsApproval,
    description:
      "Execute JavaScript code in a sandbox with access to an MCP client for the current agent context. " +
      "Use this for multi-step workflows, data transformations, or orchestrating multiple tool calls programmatically.",
    inputExamples: [
      {
        input: {
          code: "export default async (client) => { const { tools } = await client.listTools(); return tools.map(t => t.name); }",
          timeoutMs: 5000,
        },
      },
      {
        input: {
          code: 'export default async (client) => { const result = await client.callTool({ name: "search", arguments: { query: "test" } }); return result; }',
        },
      },
    ],
    inputSchema: zodSchema(
      z.object({
        code: z
          .string()
          .min(1)
          .describe(
            "JavaScript ES module code. Must export a default async function: `export default async (client) => { ... }`. " +
              "The `client` parameter is an MCP client with methods like `callTool({ name, arguments })`, `listTools()`, `listResources()`, `readResource({ uri })`, `listPrompts()`, and `getPrompt({ name })`.",
          ),
        timeoutMs: z
          .number()
          .optional()
          .describe("Execution timeout in milliseconds (default: 5000)"),
      }),
    ),
    execute: async ({ code, timeoutMs: rawTimeout }) => {
      const timeoutMs = rawTimeout ?? 5000;

      const result = await runCode({
        client: passthroughClient as Parameters<typeof runCode>[0]["client"],
        code,
        timeoutMs,
      });

      // Store result in toolOutputMap for potential read_tool_output usage
      if (result.returnValue !== undefined) {
        const serialized =
          typeof result.returnValue === "string"
            ? result.returnValue
            : JSON.stringify(result.returnValue, null, 2);

        const tokenCount = estimateJsonTokens(serialized);
        if (tokenCount > MAX_RESULT_TOKENS) {
          const toolCallId = `sandbox_${Date.now()}`;
          toolOutputMap.set(toolCallId, serialized);
          const preview = createOutputPreview(serialized);
          return {
            result: `Output too large (${tokenCount} tokens). Use read_tool_output with tool_call_id "${toolCallId}" to extract specific data.\n\nPreview:\n${preview}`,
            error: result.error,
            consoleLogs: result.consoleLogs,
          };
        }
      }

      return {
        result: result.returnValue,
        error: result.error,
        consoleLogs: result.consoleLogs,
      };
    },
  });
}
