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
