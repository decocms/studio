import type {
  CallToolRequest,
  CallToolResult,
  CompatibilityCallToolResult,
  GetPromptRequest,
  GetPromptResult,
  ListPromptsResult,
  ListResourcesResult,
  ListToolsResult,
  ReadResourceRequest,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";

export interface VirtualClient {
  listTools(): Promise<ListToolsResult>;
  callTool(
    params: CallToolRequest["params"],
  ): Promise<CallToolResult | CompatibilityCallToolResult>;
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
