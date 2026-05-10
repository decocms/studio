/**
 * Branded presets that wrap the generic "openai-compatible" provider with a
 * first-class card (logo, name, description, sensible base-URL placeholder).
 *
 * All presets store as providerId="openai-compatible" with the preset id
 * captured in the ai_provider_keys.preset_id column, so multiple configs of
 * the same preset can coexist (e.g. two LiteLLM instances) and the model
 * selector can show the branded logo + name instead of "OpenAI Compatible".
 */
export interface OpenAICompatiblePreset {
  id: string;
  name: string;
  description: string;
  logo: string;
  baseUrlPlaceholder: string;
  /**
   * Pre-fills the base URL field. Use for fixed-endpoint presets like the
   * OpenAI API. Leave undefined for presets where the URL varies per install.
   */
  defaultBaseUrl?: string;
  /** When true, the form hints that an API key is typically required. */
  apiKeyRecommended: boolean;
  /** Short copy shown in the form's helper area. */
  helpText?: string;
}

export const OPENAI_COMPATIBLE_PRESETS: OpenAICompatiblePreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    description: "GPT-4, GPT-5, and other OpenAI models",
    logo: "https://decoims.com/decocms/b51001ef-ae58-4db4-8a75-9e6d2df2dd8e/openai.png",
    baseUrlPlaceholder: "https://api.openai.com/v1",
    defaultBaseUrl: "https://api.openai.com/v1",
    apiKeyRecommended: true,
    helpText: "Use your OpenAI API key (starts with sk-).",
  },
  {
    id: "litellm",
    name: "LiteLLM",
    description: "Connect to a LiteLLM gateway your team manages",
    logo: "https://decoims.com/decocms/e974ae05-ad64-4b4a-8444-d9705f019b85/litellm.png",
    baseUrlPlaceholder: "http://localhost:4000",
    apiKeyRecommended: true,
    helpText:
      "Point at your LiteLLM proxy. The base URL should be the root of the proxy (we'll append /v1).",
  },
  {
    id: "ollama",
    name: "Ollama",
    description: "Run open-source models on your own computer",
    logo: "https://decoims.com/decocms/2bb2f822-5288-4b7c-a541-dcbef76525a0/ollama.png",
    baseUrlPlaceholder: "http://localhost:11434",
    apiKeyRecommended: false,
    helpText:
      "Ollama exposes /v1 by default — no API key required for local use.",
  },
  {
    id: "lm-studio",
    name: "LM Studio",
    description: "Open models running through LM Studio",
    logo: "https://decoims.com/decocms/9f0ab1a9-d2d5-4f3e-9de0-aadd4926428d/lmstudio.webp",
    baseUrlPlaceholder: "http://localhost:1234",
    apiKeyRecommended: false,
    helpText:
      "Start the local server in LM Studio, then paste its base URL here.",
  },
  {
    id: "vllm",
    name: "vLLM",
    description: "Connect to your team's self-hosted vLLM server",
    logo: "https://decoims.com/decocms/b6c60e4f-a4aa-443c-981f-ad0f31640e22/vllm.png",
    baseUrlPlaceholder: "http://localhost:8000",
    apiKeyRecommended: false,
  },
];

export function getPreset(
  presetId: string | null | undefined,
): OpenAICompatiblePreset | undefined {
  if (!presetId) return undefined;
  return OPENAI_COMPATIBLE_PRESETS.find((p) => p.id === presetId);
}
