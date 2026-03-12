/**
 * Decopilot Model Provider
 *
 * Factory for creating ModelProvider instances from MCP connections.
 */

import { LanguageModelBinding } from "@decocms/bindings/llm";

import { createLLMProvider } from "../../llm-provider";
import { toServerClient } from "../proxy";
import type { ClientWithOptionalStreamingSupport } from "@/mcp-clients";
import type { ModelProvider, ModelsConfig } from "./types";

/**
 * Create a ModelProvider from an MCP client
 * Accepts both regular and streamable clients
 */
export async function createModelProviderFromClient(
  client: ClientWithOptionalStreamingSupport,
  config: ModelsConfig,
): Promise<ModelProvider> {
  const llmBinding = LanguageModelBinding.forClient(toServerClient(client));
  const llmProvider = createLLMProvider(llmBinding);

  return {
    thinkingModel: llmProvider.languageModel(config.thinking.id),
    codingModel: config.coding
      ? llmProvider.languageModel(config.coding.id)
      : undefined,
    fastModel: config.fast
      ? llmProvider.languageModel(config.fast.id)
      : undefined,
    providerKeyId: config.credentialId,
  };
}
