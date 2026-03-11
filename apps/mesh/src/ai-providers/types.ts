import { ProviderV3 } from "@ai-sdk/provider";
import type { ProviderId } from "./provider-ids";

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  description: string;
  logo?: string;
}

export interface ModelInfo {
  modelId: string;
  title: string;
  description: string | null;
  logo: string | null;
  capabilities: string[];
  limits: { contextWindow: number; maxOutputTokens: number | null } | null;
  costs: { input: number; output: number } | null;
}

export interface ProviderKeyInfo {
  id: string;
  providerId: ProviderId;
  label: string;
  organizationId: string;
  createdBy: string;
  createdAt: string;
}

export interface TokenCounter {
  countTokens(params: {
    messages: unknown[];
    modelId: string;
  }): Promise<{ count: number }>;
}

export interface MeshProvider {
  readonly info: ProviderInfo;
  readonly aiSdk: ProviderV3;
  listModels(): Promise<ModelInfo[]>;
}

export type ConnectionMethod = "api-key" | "oauth-pkce";

export interface OAuthPkceParams {
  callbackUrl: string;
  codeChallenge: string; // base64url(sha256(codeVerifier))
  codeChallengeMethod: "S256";
}

export interface OAuthPkceResult {
  apiKey: string;
  userId?: string;
}

export interface ProviderAdapter {
  readonly info: ProviderInfo;
  // All connection methods supported by this provider.
  readonly supportedMethods: ConnectionMethod[];
  create(apiKey: string): MeshProvider;

  // Only defined when "oauth-pkce" is in supportedMethods
  getOAuthUrl?(params: OAuthPkceParams): string;
  exchangeOAuthCode?(params: {
    code: string;
    codeVerifier: string;
    codeChallengeMethod: "S256" | "plain";
  }): Promise<OAuthPkceResult>;
}

export interface OpenRouterModel {
  id: string;
  canonical_slug: string;
  name: string;
  created: number;
  pricing: {
    prompt: number;
    completion: number;
    request: number;
    image: number;
  };
  context_length: number;
  architecture: {
    modality: string;
    input_modalities: string[];
    output_modalities: string[];
    tokenizer: string;
  };
  top_provider: {
    is_moderated: boolean;
    context_length: number;
    max_completion_tokens: number;
  };
  supported_parameters: string[];
  description: string;
}
