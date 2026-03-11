// ============================================================================
// AI Provider Types — shared between server tool output and client hooks
// ============================================================================

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
  modelId: string;
  title: string;
  description: string | null;
  logo: string | null;
  capabilities: string[];
  limits: AiProviderModelLimits | null;
  costs: AiProviderModelCosts | null;
}

export interface AiProviderKey {
  id: string;
  providerId: string;
  label: string;
  createdBy: string;
  createdAt: string;
}
