import type { AIProviderKeyStorage } from "../storage/ai-provider-keys";
import type { ModelListCache } from "./model-list-cache";
import type { MeshProvider, ModelInfo } from "./types";
import { PROVIDERS } from "./registry";

export class AIProviderFactory {
  constructor(
    private storage: AIProviderKeyStorage,
    private cache?: ModelListCache,
  ) {}

  async activate(keyId: string, organizationId: string): Promise<MeshProvider> {
    const { keyInfo, apiKey } = await this.storage.resolve(
      keyId,
      organizationId,
    );
    const adapter = PROVIDERS[keyInfo.providerId];
    return adapter.create(apiKey);
  }

  async listModels(
    keyId: string,
    organizationId: string,
  ): Promise<ModelInfo[]> {
    const { keyInfo, apiKey } = await this.storage.resolve(
      keyId,
      organizationId,
    );
    const providerId = keyInfo.providerId;
    // if (this.cache) {
    //   const cached = await this.cache.get(organizationId, providerId);
    //   if (cached) return cached.map((m) => ({ ...m, providerId }));
    // }

    const provider = PROVIDERS[providerId].create(apiKey);
    const rawModels = await provider.listModels();

    // Providers occasionally return duplicate modelIds — keep first occurrence
    const seen = new Set<string>();
    const models = rawModels.filter((m) => {
      if (seen.has(m.modelId)) return false;
      seen.add(m.modelId);
      return true;
    });

    if (this.cache) {
      await this.cache.set(
        organizationId,
        providerId,
        models.map((m) => ({ ...m, providerId })),
      );
    }

    return models.map((m) => ({ ...m, providerId }));
  }
}
