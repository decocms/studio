import type { McpUiUpdateModelContextRequest } from "@modelcontextprotocol/ext-apps";
import type { AiProviderModel } from "../../../hooks/collections/use-ai-providers";
import type { VirtualMCPInfo } from "../select-virtual-mcp";
import type { ChatMessage, Metadata } from "../types";

// ============================================================================
// sendMessage params
// ============================================================================

export interface SendMessageParams {
  tiptapDoc?: Metadata["tiptapDoc"];
  parts?: ChatMessage["parts"];
  threadId?: string;
  model?: AiProviderModel;
  virtualMcp?: VirtualMCPInfo | null;
}

// ============================================================================
// setAppContext params
// ============================================================================

export type SetAppContextParams = McpUiUpdateModelContextRequest["params"];
