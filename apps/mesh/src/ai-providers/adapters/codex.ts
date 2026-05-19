import type { MeshProvider, ModelInfo, ProviderAdapter } from "../types";

export { createCodexModel } from "../coding-agents/codex";

const CODEX_LOGO =
  "https://assets.decocache.com/decocms/6ac44f1c-c0cf-4480-84b5-2ae6fe742d0b/codex-app.png.png";

export const CODEX_MODELS: ModelInfo[] = [
  {
    providerId: "codex",
    modelId: "codex:gpt-5.5",
    title: "GPT-5.5",
    description:
      "Frontier model for complex coding, research, and real-world work",
    capabilities: ["text", "reasoning"],
    logo: CODEX_LOGO,
    limits: null,
    costs: null,
  },
  {
    providerId: "codex",
    modelId: "codex:gpt-5.4",
    title: "GPT-5.4",
    description: "Strong model for everyday coding",
    capabilities: ["text", "reasoning"],
    logo: CODEX_LOGO,
    limits: null,
    costs: null,
  },
  {
    providerId: "codex",
    modelId: "codex:gpt-5.4-mini",
    title: "GPT-5.4 Mini",
    description:
      "Small, fast, and cost-efficient model for simpler coding tasks",
    capabilities: ["text", "reasoning"],
    logo: CODEX_LOGO,
    limits: null,
    costs: null,
  },
  {
    providerId: "codex",
    modelId: "codex:gpt-5.3-codex",
    title: "GPT-5.3 Codex",
    description: "Coding-optimized model",
    capabilities: ["text", "reasoning"],
    logo: CODEX_LOGO,
    limits: null,
    costs: null,
  },
  {
    providerId: "codex",
    modelId: "codex:gpt-5.2",
    title: "GPT-5.2",
    description: "Optimized for professional work and long-running agents",
    capabilities: ["text", "reasoning"],
    logo: CODEX_LOGO,
    limits: null,
    costs: null,
  },
];

/** Map composite model IDs to SDK model names. */
const CODEX_SDK_MODELS: Record<string, string> = {
  "codex:gpt-5.5": "gpt-5.5",
  "codex:gpt-5.4": "gpt-5.4",
  "codex:gpt-5.4-mini": "gpt-5.4-mini",
  "codex:gpt-5.3-codex": "gpt-5.3-codex",
  "codex:gpt-5.2": "gpt-5.2",
};

/** Resolve a composite codex model ID to the SDK model name. */
export function resolveCodexModelId(modelId: string): string {
  const resolved = CODEX_SDK_MODELS[modelId];
  if (!resolved) {
    throw new Error(`Unknown Codex model ID: ${modelId}`);
  }
  return resolved;
}

export const codexAdapter: ProviderAdapter = {
  info: {
    id: "codex",
    name: "Codex",
    description: "Use your ChatGPT Plus or Pro subscription",
    logo: CODEX_LOGO,
  },
  supportedMethods: ["cli-activate"],
  create(_apiKey): MeshProvider {
    return {
      info: codexAdapter.info,
      aiSdk: {} as any,
      async listModels(): Promise<ModelInfo[]> {
        return CODEX_MODELS;
      },
    };
  },
};
