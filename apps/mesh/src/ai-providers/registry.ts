import { anthropicAdapter } from "./adapters/anthropic";
import { googleAdapter } from "./adapters/google";
import { openrouterAdapter } from "./adapters/openrouter";
import type { ProviderId } from "./provider-ids";
import type { ProviderAdapter } from "./types";
import { decoAiGatewayAdapter } from "./adapters/deco-ai-gateway";

const isDecoAiGatewayEnabled = !!process.env.DECO_AI_GATEWAY_ENABLED;

export const PROVIDERS: Partial<Record<ProviderId, ProviderAdapter>> = {
  ...(isDecoAiGatewayEnabled && { deco: decoAiGatewayAdapter }),
  anthropic: anthropicAdapter,
  google: googleAdapter,
  openrouter: openrouterAdapter,
};
