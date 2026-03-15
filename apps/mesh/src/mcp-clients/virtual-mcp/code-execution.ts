/**
 * CodeExecutionClient
 *
 * Client that exposes meta-tools for code execution:
 * - GATEWAY_SEARCH_TOOLS: Search for tools by name/description
 * - GATEWAY_DESCRIBE_TOOLS: Get detailed schemas for tools
 * - GATEWAY_RUN_CODE: Execute JavaScript code with access to tools
 */

import type {
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  filterCodeExecutionTools,
  jsonError,
  jsonResult,
  runCodeWithTools,
  type ToolContext,
} from "../../tools/code-execution/utils";
import { BaseSelection } from "./base-selection";
import type { VirtualClientOptions } from "./types";

const RUN_CODE_INPUT_SCHEMA = z.object({
  code: z
    .string()
    .min(1)
    .describe(
      "JavaScript code to execute. It runs as an async function body; you can use top-level `return` and `await`.",
    ),
  timeoutMs: z
    .number()
    .default(3000)
    .describe("Max execution time in milliseconds (default: 3000)."),
});
const RUN_CODE_INPUT_JSON_SCHEMA = z.toJSONSchema(
  RUN_CODE_INPUT_SCHEMA,
) as Tool["inputSchema"];

/**
 * Client that uses code execution strategy.
 * Extends BaseSelection and adds GATEWAY_RUN_CODE meta-tool.
 */
export class CodeExecutionClient extends BaseSelection {
  constructor(options: VirtualClientOptions, ctx: any) {
    super(options, ctx);
  }

  /**
   * Get the RUN_CODE meta-tool definition
   */
  private getRunCodeTool(): Tool {
    return {
      name: "GATEWAY_RUN_CODE",
      description:
        'Run JavaScript code in a sandbox. Code must be an ES module that `export default`s an async function that receives (tools) as its first parameter. Use GATEWAY_DESCRIBE_TOOLS to understand the input/output schemas for a tool before calling it. Use `await tools.toolName(args)` or `await tools["tool-name"](args)` to call tools.',
      inputSchema: RUN_CODE_INPUT_JSON_SCHEMA,
      annotations: {
        title: "Run Code",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    };
  }

  /**
   * Handle RUN_CODE call
   */
  private async handleRunCode(
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const parsed = RUN_CODE_INPUT_SCHEMA.safeParse(args);
    if (!parsed.success) {
      return jsonError({ error: parsed.error.flatten() });
    }

    const cache = await this._cachedTools;
    // Filter out CODE_EXECUTION_* tools to avoid duplication
    const filteredTools = filterCodeExecutionTools(cache.data);

    // Create filtered context for runCodeWithTools
    const filteredContext: ToolContext = {
      tools: filteredTools,
      callTool: async (name: string, innerArgs: Record<string, unknown>) => {
        return this.routeToolCall({ name, arguments: innerArgs });
      },
      close: async () => {},
    };

    // Use shared run code logic
    const result = await runCodeWithTools(
      parsed.data.code,
      filteredContext,
      parsed.data.timeoutMs,
    );

    if (result.error) {
      return jsonError(result);
    }

    return jsonResult(result);
  }

  /**
   * List tools - returns SEARCH, DESCRIBE, and RUN_CODE meta-tools
   */
  override async listTools(): Promise<ListToolsResult> {
    const parentTools = await super.listTools();
    return {
      tools: [...parentTools.tools, this.getRunCodeTool()],
    };
  }

  /**
   * Call tool - handles RUN_CODE and delegates to parent for SEARCH/DESCRIBE
   */
  override async callTool(
    params: CallToolRequest["params"],
  ): Promise<CallToolResult> {
    if (params.name === "GATEWAY_RUN_CODE") {
      return this.handleRunCode(params.arguments ?? {});
    }
    // Delegate to BaseSelection for SEARCH and DESCRIBE
    return super.callTool(params);
  }
}
