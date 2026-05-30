import { anthropicAdapter } from "./adapters/anthropic";
import { googleAdapter } from "./adapters/google";
import { openaiCompatibleAdapter } from "./adapters/openai-compatible";
import { openrouterAdapter } from "./adapters/openrouter";
import type { ProviderId } from "./provider-ids";
import type { ProviderAdapter } from "./types";
import { decoAiGatewayAdapter } from "./adapters/deco-ai-gateway";
import { getSettings } from "../settings";

export function getProviders(): Partial<Record<ProviderId, ProviderAdapter>> {
  const settings = getSettings();
  return {
    ...(settings.aiGatewayEnabled && { deco: decoAiGatewayAdapter }),
    anthropic: anthropicAdapter,
    google: googleAdapter,
    openrouter: openrouterAdapter,
    "openai-compatible": openaiCompatibleAdapter,
  };
}
