import type { ModelCapability } from "@decocms/mesh-sdk";
import type { AIProviderKeyStorage } from "../storage/ai-provider-keys";
import type { ModelListCache } from "./model-list-cache";
import type {
  MeshProvider,
  ModelInfo,
  OpenRouterAPIModel,
  ProviderAdapter,
} from "./types";
import { getProviders } from "./registry";

// Sentinel org ID for the shared OpenRouter metadata cache (not org-specific)
const OR_INDEX_ORG_ID = "_global";

function stripProviderPrefix(id: string): string {
  return id.includes("/") ? id.split("/").slice(1).join("/") : id;
}

function mapOpenRouterModel(m: OpenRouterAPIModel): ModelInfo {
  const canTools = m.supported_parameters.includes("tools");
  const canReasoning = m.supported_parameters.includes("reasoning");
  return {
    providerId: "openrouter",
    modelId: stripProviderPrefix(m.id),
    title: m.name,
    description: m.description || null,
    logo: null,
    capabilities: [
      ...new Set([
        // "image" in input_modalities means the model accepts image input (vision),
        // not that it generates images. Remap to "vision" so we distinguish from
        // "image" in output_modalities which means actual image generation.
        ...m.architecture.input_modalities.map((mod) =>
          mod === "image" ? "vision" : mod,
        ),
        ...m.architecture.output_modalities,
        ...(canTools ? (["tools"] as const) : []),
        ...(canReasoning ? (["reasoning"] as const) : []),
      ]),
    ] as ModelCapability[],
    limits: {
      contextWindow: m.context_length,
      maxOutputTokens: m.top_provider.max_completion_tokens || null,
    },
    costs: { input: m.pricing.prompt, output: m.pricing.completion },
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
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return new Map();
    const { data }: { data: OpenRouterAPIModel[] } = await res.json();
    const models = data.map(mapOpenRouterModel);
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

  async activate(keyId: string, organizationId: string): Promise<MeshProvider> {
    const { keyInfo, apiKey } = await this.storage.resolve(
      keyId,
      organizationId,
    );
    const adapter = getProviders()[keyInfo.providerId];
    if (!adapter) throw new Error(`Unknown provider: ${keyInfo.providerId}`);
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
    const adapter = getProviders()[providerId];
    if (!adapter) throw new Error(`Unknown provider: ${providerId}`);

    if (this.cache) {
      const cached = await this.cache.get(organizationId, providerId);
      if (cached) {
        // Re-apply per-request flags (e.g. asyncResearch) on the cached
        // payload — entries cached before the flag existed otherwise leak
        // through stale.
        return applyProviderFlags(cached, adapter, apiKey);
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

    if (providerId !== "openrouter") {
      const index = await getOpenRouterIndex(this.cache);
      models = enrich(models, index);
    } else {
      // OpenRouter path skips enrich() — still apply provider-specific fixes.
      models = models.map((m) => ({
        ...m,
        capabilities: applyAnthropicPdfCapability(m.capabilities, m),
      }));
    }

    const result = models.map((m) => ({ ...m, providerId }));

    if (this.cache) {
      await this.cache.set(organizationId, providerId, result);
    }

    return applyProviderFlags(result, adapter, apiKey);
  }
}

/**
 * Stamp request-time flags onto a model list. Lets us ship new flags
 * (currently `asyncResearch`) without forcing a cache invalidation.
 *
 * Creates a provider once and reuses it across all models — `adapter.create`
 * is cheap (just closure construction) but worth not repeating per model.
 */
function applyProviderFlags(
  models: ModelInfo[],
  adapter: ProviderAdapter,
  apiKey: string,
): ModelInfo[] {
  const provider = adapter.create(apiKey);
  const asyncResearch = provider.asyncResearch;
  if (!asyncResearch) return models;
  return models.map((m) =>
    asyncResearch.canHandle(m.modelId) ? { ...m, asyncResearch: true } : m,
  );
}
