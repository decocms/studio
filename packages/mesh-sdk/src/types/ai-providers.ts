// ============================================================================
// AI Provider Types — shared between server tool output and client hooks
// ============================================================================

export const PROVIDER_IDS = ["anthropic", "openrouter"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** All known model capability tokens. Sourced from OpenRouter modality strings. */
export const MODEL_CAPABILITIES = [
  "text",
  "image",
  "vision",
  "audio",
  "video",
  "file",
] as const;

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export interface AiProviderModelLimits {
  contextWindow: number;
  /** Null means the provider does not advertise a specific cap. */
  maxOutputTokens: number | null;
}

export interface AiProviderModelCosts {
  input: number;
  output: number;
}

export interface AiProviderModel {
  providerId: string;
  modelId: string;
  title: string;
  description: string | null;
  logo: string | null;
  capabilities: ModelCapability[];
  limits: AiProviderModelLimits | null;
  costs: AiProviderModelCosts | null;
  /** Client-side only — the credential key ID used to fetch this model. */
  keyId?: string;
}

export interface AiProviderKey {
  id: string;
  providerId: string;
  label: string;
  createdBy: string;
  createdAt: string;
}
