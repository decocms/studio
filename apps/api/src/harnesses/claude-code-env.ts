/**
 * Model credentials for the sandbox-hosted claude-code harness.
 *
 * The Claude Agent SDK takes its model configuration from the environment, not
 * from an argument, so Studio's resolved credential has to be translated into
 * the variables the SDK reads and pushed to the sandbox before a run.
 *
 * Three supported shapes:
 *  - an Anthropic key, used directly;
 *  - the dispatching user's own Claude subscription, linked over OAuth, which
 *    the CLI takes on its own `CLAUDE_CODE_OAUTH_TOKEN` variable — the run then
 *    bills that person's plan, not the org's API credit;
 *  - an OpenRouter key against OpenRouter's Anthropic-compatible endpoint
 *    ("Anthropic skin"), which speaks the Messages API natively — including
 *    thinking blocks and native tool use — so no translation layer is needed.
 *    `ANTHROPIC_API_KEY` must be explicitly empty there or it wins over
 *    `ANTHROPIC_AUTH_TOKEN` and the run fails on the wrong credential.
 *    `deco` (the Deco AI Gateway) provisions OpenRouter keys used against
 *    openrouter.ai directly, so it takes the same path — as it does in every
 *    other provider switch (`provider-from-secret`, `studio-provider`).
 *
 * Anything else fails loudly at dispatch. The alternative — provisioning a pod
 * with a credential the SDK cannot use — surfaces as an opaque model error
 * several minutes later, which is much worse than a clear refusal now.
 */

/**
 * Pseudo-provider id for a user's own Claude subscription (linked over OAuth,
 * stored per user). Not an `ai-providers` registry id — it never resolves to a
 * model SDK, only to this harness's environment.
 */
export const CLAUDE_SUBSCRIPTION_PROVIDER_ID = "claude-subscription";

/** OpenRouter's Anthropic-compatible base. The SDK appends `/v1/messages`. */
const OPENROUTER_ANTHROPIC_BASE_URL = "https://openrouter.ai/api";

/**
 * The model this harness runs, per provider — the same model, named the way
 * each endpoint names it. Fixed rather than taken from the agent's thinking
 * slot: the SDK drives the `claude` CLI, which only works against Claude
 * models, so the slot's id is not usable here.
 */
const CLAUDE_CODE_MODEL = {
  anthropic: "claude-opus-5",
  openrouter: "anthropic/claude-opus-5",
} as const;

/** The subset of a resolved model source this needs. */
export interface ClaudeCodeCredential {
  providerId: string;
  apiKey: string;
  /** Credential-specific override; wins over the provider default. */
  baseUrl?: string;
}

export class UnsupportedClaudeCodeProviderError extends Error {
  constructor(providerId: string) {
    super(
      `the claude-code harness needs an Anthropic, OpenRouter or Deco model ` +
        `credential; this run's model resolves to "${providerId}". Point the ` +
        `agent's thinking model at one of those, or run it with Decopilot.`,
    );
    this.name = "UnsupportedClaudeCodeProviderError";
  }
}

/**
 * Environment for one run. Values are secrets — never log the result.
 *
 * `null` deletes a variable on the daemon's config channel, which is how a
 * sandbox that previously ran with a different credential shape stops carrying
 * the stale one (a leftover `ANTHROPIC_API_KEY` would silently outrank an
 * OpenRouter auth token).
 */
export function claudeCodeEnvFromCredential(
  credential: ClaudeCodeCredential,
): Record<string, string | null> {
  const { providerId, apiKey, baseUrl } = credential;
  if (providerId === "anthropic") {
    return {
      CLAUDE_CODE_MODEL: CLAUDE_CODE_MODEL.anthropic,
      ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_AUTH_TOKEN: null,
      CLAUDE_CODE_OAUTH_TOKEN: null,
      ANTHROPIC_BASE_URL: baseUrl ?? null,
    };
  }
  if (providerId === CLAUDE_SUBSCRIPTION_PROVIDER_ID) {
    // A user's own Claude plan, linked over OAuth. The CLI reads the OAuth
    // token from its own variable; both key variables must be cleared or a
    // leftover one outranks it and the run bills the org's API credit instead.
    return {
      CLAUDE_CODE_MODEL: CLAUDE_CODE_MODEL.anthropic,
      CLAUDE_CODE_OAUTH_TOKEN: apiKey,
      ANTHROPIC_API_KEY: null,
      ANTHROPIC_AUTH_TOKEN: null,
      ANTHROPIC_BASE_URL: null,
    };
  }
  if (providerId === "openrouter" || providerId === "deco") {
    return {
      CLAUDE_CODE_MODEL: CLAUDE_CODE_MODEL.openrouter,
      // Empty, not absent: a non-empty API key takes precedence over the auth
      // token and would be sent to OpenRouter as an Anthropic key.
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: apiKey,
      CLAUDE_CODE_OAUTH_TOKEN: null,
      ANTHROPIC_BASE_URL: baseUrl ?? OPENROUTER_ANTHROPIC_BASE_URL,
    };
  }
  throw new UnsupportedClaudeCodeProviderError(providerId);
}
