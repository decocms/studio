import { tool, zodSchema } from "ai";
import { z } from "zod";
import { runCode, type ToolHandler } from "@/sandbox";
import type {
  CallToolRequest,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { estimateJsonTokens } from "./read-tool-output";

export interface VirtualClient {
  listTools(): Promise<ListToolsResult>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  callTool(params: CallToolRequest["params"]): Promise<any>;
}

export interface SandboxToolParams {
  readonly passthroughClient: VirtualClient;
  readonly toolOutputMap: Map<string, string>;
}

export function createSandboxTool(params: SandboxToolParams) {
  const { passthroughClient, toolOutputMap } = params;
  return tool({
    description:
      "Execute JavaScript code in a sandbox with access to the MCP tools available in the current agent context. " +
      "Use this for multi-step workflows, data transformations, or orchestrating multiple tool calls programmatically.",
    inputExamples: [
      {
        input: {
          code: "export default async (tools) => { const result = await tools.list_items({}); return result; }",
          timeoutMs: 5000,
        },
      },
      {
        input: {
          code: 'export default async (tools) => { const items = await tools.search({ query: "test" }); return items.filter(i => i.status === "active"); }',
        },
      },
    ],
    inputSchema: zodSchema(
      z.object({
        code: z
          .string()
          .min(1)
          .describe(
            "JavaScript ES module code. Must export a default async function: `export default async (tools) => { ... }`. " +
              "The `tools` parameter is an object where keys are tool names and values are async functions that accept an arguments object.",
          ),
        timeoutMs: z
          .number()
          .optional()
          .describe("Execution timeout in milliseconds (default: 5000)"),
      }),
    ),
    execute: async ({ code, timeoutMs: rawTimeout }) => {
      const timeoutMs = rawTimeout ?? 5000;
      const { tools: mcpTools } = await passthroughClient.listTools();

      const toolsRecord: Record<string, ToolHandler> = {};
      for (const t of mcpTools) {
        toolsRecord[t.name] = async (args: Record<string, unknown>) => {
          const result = await passthroughClient.callTool({
            name: t.name,
            arguments: args,
          });

          if (result.structuredContent) {
            return result.structuredContent;
          }

          const content = result.content as
            | Array<{ type: string; text?: string }>
            | undefined;
          const textParts = content
            ?.filter(
              (c): c is { type: "text"; text: string } => c.type === "text",
            )
            .map((c) => c.text);

          const text = textParts?.join("\n") ?? "";
          try {
            return JSON.parse(text);
          } catch {
            return text;
          }
        };
      }

      const result = await runCode({ tools: toolsRecord, code, timeoutMs });

      // Store result in toolOutputMap for potential read_tool_output usage
      if (result.returnValue !== undefined) {
        const serialized =
          typeof result.returnValue === "string"
            ? result.returnValue
            : JSON.stringify(result.returnValue, null, 2);

        const tokenCount = estimateJsonTokens(serialized);
        if (tokenCount > 4000) {
          const toolCallId = `sandbox_${Date.now()}`;
          toolOutputMap.set(toolCallId, serialized);
          return {
            result: `Output too large (${tokenCount} tokens). Use read_tool_output with tool_call_id "${toolCallId}" to extract specific data.`,
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
