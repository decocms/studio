export type ProviderId =
  | "deco"
  | "anthropic"
  | "openrouter"
  | "llmapi"
  | "google"
  | "claude-code"
  | "codex"
  | "openai-compatible";

export type ModelCapability =
  | "text"
  | "image"
  | "vision"
  | "audio"
  | "video"
  | "file"
  | "reasoning";

export interface ModelInfo {
  providerId: ProviderId;
  modelId: string;
  title: string;
  description?: string | null;
  logo?: string | null;
  capabilities: ModelCapability[];
  limits?: { contextWindow: number; maxOutputTokens: number | null } | null;
  costs: { input: number; output: number } | null;
  deprecated?: boolean;
  asyncResearch?: boolean;
}
