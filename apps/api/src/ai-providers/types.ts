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
   * Only defined for providers that gate features by plan. Returns the org's
   * plan, its effective feature flags and the AI usage bar — a PERCENT, never
   * a dollar or token amount. `usage` is null when the provider could not
   * read it, which callers must render as unknown rather than as empty.
   */
  getEntitlements?(
    studioJwt: string,
    organizationId: string,
  ): Promise<PlanEntitlements>;

  /** The plan catalog a picker renders: names and feature flags, no amounts. */
  listPlans?(
    studioJwt: string,
    organizationId: string,
  ): Promise<{ id: string; name: string; features: Record<string, boolean> }[]>;

  /** Move the org onto a plan ('free' drops it back to the free tier). Takes
   *  no payment — whatever charges the customer runs before this. */
  setPlan?(
    studioJwt: string,
    organizationId: string,
    planId: string,
  ): Promise<PlanEntitlements>;

  /**
   * Server-to-server key provisioning (e.g. on org creation).
   * studioJwt is a gateway-compatible JWT minted by mintGatewayJwt(userId).
   */
  provisionKey?(studioJwt: string, organizationId: string): Promise<string>;
}

export interface PlanEntitlements {
  plan: { id: string; name: string };
  features: Record<string, boolean>;
  /**
   * The AI usage bar. `percent` is a fraction 0–1 and is what gets rendered.
   *
   * `usedMicros`/`limitMicros` are its numerator and denominator, and exist for
   * ONE job: letting the browser advance the percent by a turn's cost the
   * instant the turn ends. The provider's usage counter settles asynchronously,
   * so the refetch after a message routinely returns the pre-turn number and a
   * bar that never visibly moves. They are arithmetic, NEVER rendered — §1
   * still holds, the bar is a percent and the only amount an org is shown is a
   * wallet top-up. Null when the gateway predates the fields.
   */
  usage: {
    percent: number;
    state: "ok" | "warn" | "exhausted";
    usedMicros: number | null;
    limitMicros: number | null;
  } | null;
  /**
   * Money the org bought and has not spent, in dollars. The second pool: the
   * bar is the plan's monthly envelope as a percent and money cannot move it;
   * this is what the org spends once the bar is full, and the one place in the
   * product an amount is shown. Null when the gateway could not read usage.
   */
  credits: { remainingUsd: number } | null;
  /**
   * Which model runs this org's work, per tier, set by a deco admin (§6 of the
   * pricing doc). Bare OpenRouter model ids; an absent tier is not pinned and
   * falls through to `resolveTier`'s own chain.
   *
   * SERVER-ONLY — never put this in a payload the browser receives. §6
   * withholds the model's NAME below Ultra, not just the picker, which is the
   * whole reason the pin lives on the gateway rather than in org settings the
   * client can read. `AI_PLAN_ENTITLEMENTS` projects it out deliberately.
   *
   * Null when the gateway declined to answer — which it does for any caller
   * that is not mesh's server and does not own `model_choice`.
   */
  modelPins: Record<string, string> | null;
  tasks: {
    allowed: boolean;
    remaining: number | null;
    denyReason: string | null;
  };
  /** Null in TRIAL mode (a plan whose allowance is 0). The bar is then
   *  lifetime spend over lifetime deposits, so there is no period in it and
   *  nothing resets — see the gateway's `getEntitlements`. */
  periodStart: string | null;
  /** When the usage bar resets, or null when it never does. Rendering "Resets
   *  on {date}" beside "chat pauses until you upgrade" is a promise the trial
   *  cannot keep. */
  periodEnd: string | null;
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
