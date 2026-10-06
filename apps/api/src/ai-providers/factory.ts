import type { ModelCapability } from "@decocms/shared/sdk";
import type { AIProviderKeyStorage } from "../storage/ai-provider-keys";
import type { ModelListCache } from "./model-list-cache";
import type { StudioProvider, ModelInfo, OpenRouterAPIModel } from "./types";
import { getProviders } from "./registry";
import {
  fetchWithTransientRetry,
  throwResponseError,
} from "./adapters/fetch-transient-retry";
import { deriveModalityCapabilities } from "./adapters/model-capabilities";

// Sentinel org ID for the shared OpenRouter metadata cache (not org-specific)
const OR_INDEX_ORG_ID = "_global";

function stripProviderPrefix(id: string): string {
  return id.includes("/") ? id.split("/").slice(1).join("/") : id;
}

// Skips a model missing the nested metadata mapOpenRouterModel relies on (mirrors adapters/openrouter.ts).
function isMappableModel(m: OpenRouterAPIModel): boolean {
  return (
    typeof m.id === "string" &&
    !!m.architecture &&
    Array.isArray(m.architecture.input_modalities) &&
    Array.isArray(m.architecture.output_modalities) &&
    !!m.top_provider &&
    !!m.pricing
  );
}

function mapOpenRouterModel(m: OpenRouterAPIModel): ModelInfo {
  return {
    providerId: "openrouter",
    modelId: stripProviderPrefix(m.id),
    title: m.name,
    description: m.description || null,
    logo: null,
    capabilities: deriveModalityCapabilities(
      m.architecture.input_modalities,
      m.architecture.output_modalities,
      m.supported_parameters,
      m.supported_parameters?.includes("reasoning") ? ["reasoning"] : [],
    ),
    limits: {
      // OpenRouter can omit context_length; mirror the adapters/openrouter.ts guard.
      contextWindow: m.context_length ?? 0,
      maxOutputTokens: m.top_provider.max_completion_tokens || null,
    },
    costs: {
      input: Number(m.pricing.prompt) || 0,
      output: Number(m.pricing.completion) || 0,
    },
  };
}

function buildIndex(models: ModelInfo[]): Map<string, Partial<ModelInfo>> {
  const map = new Map<string, Partial<ModelInfo>>();
  for (const m of models) {
    const meta = {
      description: m.description,
      capabilities: m.capabilities,
      limits: m.limits,
      costs: m.costs,
    };
    map.set(m.modelId, meta);
    // OpenRouter uses dots in version numbers (claude-sonnet-4.6); store a dashed alias
    // so providers that use dashes (Anthropic: claude-sonnet-4-6) can find the entry.
    const dashed = m.modelId.replace(/\./g, "-");
    if (dashed !== m.modelId) map.set(dashed, meta);
  }
  return map;
}

async function getOpenRouterIndex(
  cache?: ModelListCache,
): Promise<Map<string, Partial<ModelInfo>>> {
  if (cache) {
    const cached = await cache.get(OR_INDEX_ORG_ID, "openrouter");
    if (cached) return buildIndex(cached);
  }
  try {
    const res = await fetchWithTransientRetry(
      "OpenRouter enrichment index",
      "https://openrouter.ai/api/v1/models",
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) await throwResponseError("OpenRouter enrichment index", res);
    const { data }: { data: OpenRouterAPIModel[] } = await res.json();
    const models = data.filter(isMappableModel).map(mapOpenRouterModel);
    if (cache) await cache.set(OR_INDEX_ORG_ID, "openrouter", models);
    return buildIndex(models);
  } catch {
    return new Map();
  }
}

// Generates all candidate IDs to try when matching a model against the OpenRouter index.
// Add new entries here when you encounter a new cross-provider naming difference.
//   - dots vs dashes: OpenRouter uses "claude-sonnet-4.6", Anthropic uses "claude-sonnet-4-6"
//   - date suffix: Anthropic appends -YYYYMMDD (e.g. "claude-opus-4-20250514")
function candidateIds(modelId: string): string[] {
  const dashed = modelId.replace(/\./g, "-");
  const withoutDate = modelId.replace(/-\d{8}$/, "");
  const dashedWithoutDate = withoutDate.replace(/\./g, "-");
  return [...new Set([modelId, dashed, withoutDate, dashedWithoutDate])];
}

// Anthropic's document blocks support PDFs on all vision-capable Claude models.
// This covers both direct Anthropic keys (providerId="anthropic") and models
// routed through OpenRouter/deco (modelId starts with "anthropic/").
function isAnthropicModel(m: ModelInfo): boolean {
  return m.providerId === "anthropic" || m.modelId.startsWith("anthropic/");
}

function applyAnthropicPdfCapability(
  caps: ModelCapability[],
  m: ModelInfo,
): ModelCapability[] {
  if (
    isAnthropicModel(m) &&
    caps.includes("vision") &&
    !caps.includes("file")
  ) {
    return [...caps, "file"] as ModelCapability[];
  }
  return caps;
}

function enrich(
  models: ModelInfo[],
  index: Map<string, Partial<ModelInfo>>,
): ModelInfo[] {
  return models.map((m) => {
    const candidates = candidateIds(m.modelId);
    const meta = candidates.map((id) => index.get(id)).find(Boolean);
    const rawCaps: ModelCapability[] = m.capabilities.length
      ? m.capabilities
      : (meta?.capabilities ?? []);
    const caps = applyAnthropicPdfCapability(rawCaps, m);
    if (!meta) {
      return caps === rawCaps ? m : { ...m, capabilities: caps };
    }
    return {
      ...m,
      description: m.description ?? meta.description ?? null,
      capabilities: caps,
      limits: m.limits ?? meta.limits ?? null,
      costs: m.costs ?? meta.costs ?? null,
    };
  });
}

export class AIProviderFactory {
  constructor(
    private storage: AIProviderKeyStorage,
    private cache?: ModelListCache,
  ) {}

  async activate(
    keyId: string,
    organizationId: string,
  ): Promise<StudioProvider> {
    const { keyInfo, apiKey } = await this.storage.resolve(
      keyId,
      organizationId,
    );
    const adapter = getProviders()[keyInfo.providerId];
    if (!adapter) throw new Error(`Unknown provider: ${keyInfo.providerId}`);
    return adapter.create(apiKey);
  }

  /** Discover Decisions only when requested; never block the chat catalog on it. */
  async listDecisionModels(
    keyId: string,
    organizationId: string,
  ): Promise<ModelInfo[]> {
    const provider = await this.activate(keyId, organizationId);
    if (!provider.decisions?.listModels)
      throw new Error("Provider does not support decision model discovery");
    const cacheId = `${provider.info.id}:decisions`;
    const cached = await this.cache?.get(organizationId, cacheId);
    if (cached) return cached;
    const seen = new Set<string>();
    const models = (await provider.decisions.listModels())
      .filter((model) => {
        if (
          model.deprecated ||
          !model.capabilities.includes("decisions") ||
          seen.has(model.modelId)
        )
          return false;
        seen.add(model.modelId);
        return true;
      })
      .map((model) => ({ ...model, providerId: provider.info.id }));
    await this.cache?.set(organizationId, cacheId, models);
    return models;
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
    const adapter = getProviders()[providerId];
    if (!adapter) throw new Error(`Unknown provider: ${providerId}`);

    if (this.cache) {
      const cached = await this.cache.get(organizationId, providerId);
      if (cached) {
        // Re-apply per-request flags (e.g. asyncResearch) on the cached
        // payload — entries cached before the flag existed otherwise leak
        // through stale.
        return applyProviderFlags(cached, adapter.create(apiKey));
      }
    }

    const provider = adapter.create(apiKey);
    const rawModels = await provider.listModels();

    // Drop deprecated and duplicate models
    const seen = new Set<string>();
    let models = rawModels.filter((m) => {
      if (m.deprecated) return false;
      if (seen.has(m.modelId)) return false;
      seen.add(m.modelId);
      return true;
    });

    if (providerId !== "openrouter" && providerId !== "deco") {
      const index = await getOpenRouterIndex(this.cache);
      models = enrich(models, index);
    } else {
      // Both catalogs already come from OpenRouter; only apply local fixes.
      models = models.map((m) => ({
        ...m,
        capabilities: applyAnthropicPdfCapability(m.capabilities, m),
      }));
    }

    const result = models.map((m) => ({ ...m, providerId }));

    if (this.cache) {
      await this.cache.set(organizationId, providerId, result);
    }

    return applyProviderFlags(result, provider);
  }
}

/**
 * Stamp request-time flags onto a model list. Lets us ship new flags
 * (currently `asyncResearch`) without forcing a cache invalidation.
 */
function applyProviderFlags(
  models: ModelInfo[],
  provider: StudioProvider,
): ModelInfo[] {
  const asyncResearch = provider.asyncResearch;
  if (!asyncResearch) return models;
  return models.map((m) =>
    asyncResearch.canHandle(m.modelId) ? { ...m, asyncResearch: true } : m,
  );
}
