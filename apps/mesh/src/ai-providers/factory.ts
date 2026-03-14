import type { ModelCapability } from "@decocms/mesh-sdk";
import type { AIProviderKeyStorage } from "../storage/ai-provider-keys";
import type { ModelListCache } from "./model-list-cache";
import type { MeshProvider, ModelInfo, OpenRouterAPIModel } from "./types";
import { PROVIDERS } from "./registry";

/** Static model list for the Claude Code local provider. */
const CLAUDE_CODE_MODEL_LIST: ModelInfo[] = [
  {
    providerId: "claude-code",
    modelId: "claude-code:opus",
    title: "Claude Code: Opus",
    description: "Most capable model via local Claude Code CLI (1M context)",
    logo: null,
    capabilities: ["text"] as ModelCapability[],
    limits: { contextWindow: 1_000_000, maxOutputTokens: 32_768 },
    costs: null,
  },
  {
    providerId: "claude-code",
    modelId: "claude-code:sonnet",
    title: "Claude Code: Sonnet",
    description: "Fast, capable model via local Claude Code CLI (1M context)",
    logo: null,
    capabilities: ["text"] as ModelCapability[],
    limits: { contextWindow: 1_000_000, maxOutputTokens: 32_768 },
    costs: null,
  },
  {
    providerId: "claude-code",
    modelId: "claude-code:haiku",
    title: "Claude Code: Haiku",
    description: "Fastest, most affordable model via local Claude Code CLI",
    logo: null,
    capabilities: ["text"] as ModelCapability[],
    limits: { contextWindow: 200_000, maxOutputTokens: 32_768 },
    costs: null,
  },
];

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
        ...m.architecture.input_modalities,
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

function enrich(
  models: ModelInfo[],
  index: Map<string, Partial<ModelInfo>>,
): ModelInfo[] {
  return models.map((m) => {
    const candidates = candidateIds(m.modelId);
    const meta = candidates.map((id) => index.get(id)).find(Boolean);
    if (!meta) {
      return m;
    }
    return {
      ...m,
      description: m.description ?? meta.description ?? null,
      capabilities: m.capabilities.length
        ? m.capabilities
        : (meta.capabilities ?? []),
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
    const adapter = PROVIDERS[keyInfo.providerId];
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

    // Claude Code uses the local CLI — return static model list
    if (providerId === "claude-code") {
      return CLAUDE_CODE_MODEL_LIST;
    }

    if (this.cache) {
      const cached = await this.cache.get(organizationId, providerId);
      if (cached) return cached;
    }

    const adapter = PROVIDERS[providerId];
    if (!adapter) throw new Error(`Unknown provider: ${providerId}`);
    const provider = adapter.create(apiKey);
    const rawModels = await provider.listModels();

    // Providers occasionally return duplicate modelIds — keep first occurrence
    const seen = new Set<string>();
    let models = rawModels.filter((m) => {
      if (seen.has(m.modelId)) return false;
      seen.add(m.modelId);
      return true;
    });

    if (providerId !== "openrouter") {
      const index = await getOpenRouterIndex(this.cache);
      models = enrich(models, index);
    }

    const result = models.map((m) => ({ ...m, providerId }));

    if (this.cache) {
      await this.cache.set(organizationId, providerId, result);
    }

    return result;
  }
}
