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
 * Which model a run gets. Not the agent's thinking slot — the SDK drives the
 * `claude` CLI, which only works against Claude models, so the slot's id is not
 * usable here.
 *
 * `reviewer` is a cheaper tier for the QA Agent and Code Reviewer, whose job is
 * to read a diff and reach a verdict rather than write the change. Together
 * those two ran MORE threads than the Super Agent on one month of production
 * boards (1,247 vs 707) and took 57% of the spend — all of it at the builder's
 * model. Opt-in per org via the `cheap_reviewer_model` flag; unset orgs keep
 * running every role on `default`, which is what shipped before.
 */
export type ClaudeCodeModelClass = "default" | "reviewer";

const CLAUDE_CODE_MODEL: Record<
  "anthropic" | "openrouter",
  Record<ClaudeCodeModelClass, string>
> = {
  anthropic: { default: "claude-opus-5", reviewer: "claude-sonnet-5" },
  openrouter: {
    default: "anthropic/claude-opus-5",
    reviewer: "anthropic/claude-sonnet-5",
  },
};

/**
 * `runMetadata` key carrying the class from the enqueue to this dispatch. A
 * free-form string on the durable run snapshot, same as `runClass` — adding it
 * changes no schema and no DBOS step I/O.
 */
export const MODEL_CLASS_METADATA_KEY = "claudeCodeModelClass";

/** Narrow an untrusted `runMetadata` value to a class. Pure — unit-tested. */
export function modelClassFromMetadata(
  value: string | undefined,
): ClaudeCodeModelClass {
  return value === "reviewer" ? "reviewer" : "default";
}

/**
 * Per-response output ceiling for the CLI, in tokens.
 *
 * Unset, the SDK asks for the model's own maximum (64k on Opus), and OpenRouter
 * rejects the WHOLE request with a 402 unless the balance covers that ceiling —
 * even though a turn almost never emits a fraction of it. That was the single
 * biggest killer of production runs: 28 of 36 fatal thread errors across six
 * orgs read `requires more credits … requested up to 64000 tokens, but can only
 * afford 47750`, and every one of them forced a fresh retry that re-read the
 * whole context.
 *
 * 32k is above any turn we have observed and halves the balance a run must hold
 * to start. It bounds the REQUEST, not the work: a turn that needs more output
 * continues in the next one.
 */
export const CLAUDE_CODE_MAX_OUTPUT_TOKENS = 32_000;

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
  modelClass: ClaudeCodeModelClass = "default",
): Record<string, string | null> {
  const { providerId, apiKey, baseUrl } = credential;
  /** A property of the run, not of the credential — so every shape carries it. */
  const budget = {
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: `${CLAUDE_CODE_MAX_OUTPUT_TOKENS}`,
  };
  if (providerId === "anthropic") {
    return {
      ...budget,
      CLAUDE_CODE_MODEL: CLAUDE_CODE_MODEL.anthropic[modelClass],
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
      ...budget,
      CLAUDE_CODE_MODEL: CLAUDE_CODE_MODEL.anthropic[modelClass],
      CLAUDE_CODE_OAUTH_TOKEN: apiKey,
      ANTHROPIC_API_KEY: null,
      ANTHROPIC_AUTH_TOKEN: null,
      ANTHROPIC_BASE_URL: null,
    };
  }
  if (providerId === "openrouter" || providerId === "deco") {
    return {
      ...budget,
      CLAUDE_CODE_MODEL: CLAUDE_CODE_MODEL.openrouter[modelClass],
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
