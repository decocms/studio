import {
  isHostedProviderId,
  type AiProviderInfo,
  type AiProviderKey,
} from "@/sdk";

export interface ProviderInventoryRow {
  key: AiProviderKey;
  provider: AiProviderInfo | null;
}

export function getProviderInventoryState(keys: AiProviderKey[]) {
  const hostedKeys = keys.filter((key) => isHostedProviderId(key.providerId));

  return {
    hasInventory: keys.length > 0,
    hasHostedProvider: hostedKeys.length > 0,
    hasDeco: hostedKeys.some((key) => key.providerId === "deco"),
  };
}

export function buildProviderInventoryRows(
  keys: AiProviderKey[],
  providers: AiProviderInfo[],
): ProviderInventoryRow[] {
  return keys
    .filter((key) => key.providerId !== "deco")
    .map((key) => ({
      key,
      provider:
        providers.find((provider) => provider.id === key.providerId) ?? null,
    }));
}
