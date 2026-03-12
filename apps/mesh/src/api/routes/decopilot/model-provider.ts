/**
 * Decopilot Model Provider
 *
 * Factory for creating ModelProvider instances from MCP connections.
 * Used by the legacy connection-based path; new code uses AIProviderFactory.
 */

import { LanguageModelBinding } from "@decocms/bindings/llm";

import { createLLMProvider } from "../../llm-provider";
import { toServerClient } from "../proxy";
import type { ClientWithOptionalStreamingSupport } from "@/mcp-clients";
import type { MeshProvider } from "@/ai-providers/types";
import type { ModelProvider, ModelsConfig } from "./types";

/**
 * Create a ModelProvider from an MCP client (legacy connection path).
 * Accepts both regular and streamable clients.
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
    providerKeyId: config.connectionId ?? "",
  };
}

/**
 * Wrap a legacy ModelProvider (V2 models) into the MeshProvider interface
 * so the new provider-agnostic code paths can consume it.
 * Removed once the UI migrates to credentialId (PR5).
 */
export function wrapLegacyProvider(
  mp: ModelProvider,
  models: ModelsConfig,
): MeshProvider {
  return {
    info: { id: "openrouter", name: "", description: "" } as never,
    aiSdk: {
      languageModel: (_modelId: string) => {
        // fast → fastModel if available, else thinkingModel
        if (models.fast && _modelId === models.fast.id) {
          return (mp.fastModel ?? mp.thinkingModel) as never;
        }
        if (models.coding && _modelId === models.coding.id) {
          return (mp.codingModel ?? mp.thinkingModel) as never;
        }
        return mp.thinkingModel as never;
      },
    } as never,
    listModels: async () => [],
  };
}
