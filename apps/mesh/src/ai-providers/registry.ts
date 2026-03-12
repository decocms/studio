import { anthropicAdapter } from "./adapters/anthropic";
import { openrouterAdapter } from "./adapters/openrouter";
import type { ProviderId } from "./provider-ids";
import type { ProviderAdapter } from "./types";

export const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openrouter: openrouterAdapter,
};
