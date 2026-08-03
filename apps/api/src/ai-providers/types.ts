export { AsyncResearchTerminalError } from "../shared/async-research-terminal-error";
export type { ProviderKeyInfo } from "../storage/types";

/**
 * `StudioProvider` + its portable dependencies + `createLanguageModel` now live
 * in the portable harness package (`@/harnesses/lib/decopilot/studio-provider`).
 * These re-exports keep every existing `@/ai-providers/types` importer
 * compiling against the hosted Decopilot implementation.
 */
export type {
  AsyncResearchProvider,
  AsyncResearchResult,
  StudioProvider,
  ModelInfo,
  ProviderInfo,
} from "@/harnesses/lib/decopilot/studio-provider";

import type {
  StudioProvider,
  ProviderInfo,
} from "@/harnesses/lib/decopilot/studio-provider";

export interface TokenCounter {
  countTokens(params: {
    messages: unknown[];
    modelId: string;
  }): Promise<{ count: number }>;
}

export type ConnectionMethod = "api-key" | "oauth-pkce";

export interface OAuthPkceParams {
  callbackUrl: string;
  codeChallenge: string; // base64url(sha256(codeVerifier))
  codeChallengeMethod: "S256";
  organizationId?: string;
}

export interface OAuthPkceResult {
  apiKey: string;
  userId?: string;
}

export interface ProviderAdapter {
  readonly info: ProviderInfo;
  // All connection methods supported by this provider.
  readonly supportedMethods: ConnectionMethod[];
  create(apiKey: string): StudioProvider;

  // Only defined when "oauth-pkce" is in supportedMethods
  getOAuthUrl?(params: OAuthPkceParams): string;
  exchangeOAuthCode?(params: {
    code: string;
    codeVerifier: string;
    codeChallengeMethod: "S256" | "plain";
  }): Promise<OAuthPkceResult>;

  // Only defined for providers that support credit top-ups
  getTopUpUrl?(
    studioJwt: string,
    orgId: string,
    amountCents: number,
    currency?: "usd" | "brl",
  ): Promise<string>;

  // Only defined for providers that expose a credits balance.
  // studioJwt is a gateway-compatible JWT minted by mintGatewayJwt(userId).
  getCreditsBalance?(
    studioJwt: string,
    organizationId: string,
  ): Promise<{ balanceCents: number }>;

  /**
   * Server-to-server key provisioning (e.g. on org creation).
   * studioJwt is a gateway-compatible JWT minted by mintGatewayJwt(userId).
   */
  provisionKey?(studioJwt: string, organizationId: string): Promise<string>;
}

export interface OpenRouterAPIModel {
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
