import { ProviderV3 } from "@ai-sdk/provider";
import type { ModelCapability } from "@decocms/mesh-sdk";
import type { ProviderId } from "./provider-ids";
export type { ProviderKeyInfo } from "../storage/types";

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  description: string;
  logo?: string;
}

export interface ModelInfo {
  providerId: ProviderId;
  modelId: string;
  title: string;
  description?: string | null;
  logo?: string | null;
  capabilities: ModelCapability[];
  limits?: { contextWindow: number; maxOutputTokens: number | null } | null;
  costs: { input: number; output: number } | null;
  /** When true the upstream provider has flagged this model as deprecated. */
  deprecated?: boolean;
  /** Mirrors `AiProviderModel.asyncResearch` — restricts this model to the
   *  deep-research slot. */
  asyncResearch?: boolean;
}

export interface TokenCounter {
  countTokens(params: {
    messages: unknown[];
    modelId: string;
  }): Promise<{ count: number }>;
}

export interface AsyncResearchResult {
  text: string;
  citations: Array<{ url: string; title?: string }>;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Thrown by `AsyncResearchProvider.resume` when the underlying job reaches a
 * terminal failure state on the provider's side (e.g. Gemini's interaction
 * status transitioned to `failed`/`cancelled`). The job no longer exists to
 * resume, so callers should drop any persisted handle.
 *
 * Plain `Error` from `resume` means our own poll/HTTP failed transiently —
 * the provider-side job may still be running; the handle should be kept for
 * a future reconnect.
 */
export class AsyncResearchTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsyncResearchTerminalError";
  }
}

/**
 * Generic capability for "research" jobs that don't fit streamText — they're
 * submit-then-poll, take minutes, and need to survive pod death. Each adapter
 * decides which of its models route through this path; the caller doesn't
 * know whether the underlying protocol is Gemini's Interactions API,
 * something OpenAI ships later, etc.
 */
export interface AsyncResearchProvider {
  /** Whether the given model id should be driven through this capability. */
  canHandle(modelId: string): boolean;
  /** Submit a new job. Returns an adapter-opaque handle that survives restarts. */
  start(req: {
    modelId: string;
    query: string;
    abortSignal?: AbortSignal;
  }): Promise<{ jobId: string }>;
  /**
   * Drive an already-submitted job to terminal state. Same call works for the
   * pod that submitted it AND for a fresh pod resuming after a crash.
   */
  resume(req: {
    jobId: string;
    abortSignal?: AbortSignal;
    onProgress?: (transcript: string) => void;
    pollIntervalMs?: number;
  }): Promise<AsyncResearchResult>;
}

export interface MeshProvider {
  readonly info: ProviderInfo;
  readonly aiSdk: ProviderV3;
  /** Set by providers that expose async/long-running research jobs. */
  readonly asyncResearch?: AsyncResearchProvider;
  listModels(): Promise<ModelInfo[]>;
}

export type ConnectionMethod = "api-key" | "oauth-pkce" | "cli-activate";

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
  create(apiKey: string): MeshProvider;

  // Only defined when "oauth-pkce" is in supportedMethods
  getOAuthUrl?(params: OAuthPkceParams): string;
  exchangeOAuthCode?(params: {
    code: string;
    codeVerifier: string;
    codeChallengeMethod: "S256" | "plain";
  }): Promise<OAuthPkceResult>;

  // Only defined for providers that support credit top-ups
  getTopUpUrl?(
    meshJwt: string,
    orgId: string,
    amountCents: number,
    currency?: "usd" | "brl",
  ): Promise<string>;

  // Only defined for providers that expose a credits balance.
  // meshJwt is a gateway-compatible JWT minted by mintGatewayJwt(userId).
  getCreditsBalance?(
    meshJwt: string,
    organizationId: string,
  ): Promise<{ balanceCents: number }>;

  /**
   * Server-to-server key provisioning (e.g. on org creation).
   * meshJwt is a gateway-compatible JWT minted by mintGatewayJwt(userId).
   */
  provisionKey?(meshJwt: string, organizationId: string): Promise<string>;
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
