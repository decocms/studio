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
 * `reviewer` is a cheaper tier for the Reviewer, whose job is
 * to read a diff and reach a verdict rather than write the change. Together
 * those two ran MORE threads than the Super Agent on one month of production
 * boards (1,247 vs 707) and took 57% of the spend — all of it at the builder's
 * model. On by default via the `cheap_reviewer_model` flag; an org opts back
 * into reviewing on the builder's model by setting it to exactly `false`.
 *
 * `conflict` is the same cheap tier for a merge-conflict re-run. The change is
 * already written and already approved; the run replays the base branch over it
 * and reconciles two known texts. That is not the work the builder's model is
 * priced for, and it is a class of its own rather than `reviewer` so the run
 * metadata says what the run actually was.
 */
export type ClaudeCodeModelClass = "default" | "reviewer" | "conflict";

const CLAUDE_CODE_MODEL: Record<
  "anthropic" | "openrouter",
  Record<ClaudeCodeModelClass, string>
> = {
  anthropic: {
    default: "claude-opus-5",
    reviewer: "claude-sonnet-5",
    conflict: "claude-sonnet-5",
  },
  openrouter: {
    default: "anthropic/claude-opus-5",
    reviewer: "anthropic/claude-sonnet-5",
    conflict: "anthropic/claude-sonnet-5",
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
  if (value === "reviewer") return "reviewer";
  if (value === "conflict") return "conflict";
  return "default";
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

/**
 * Per-run turn ceiling, by class. `null` means "the SDK's own default", which
 * is what the Super Agent keeps — capping the role that writes the change would
 * strand half-finished work on a branch.
 *
 * A reviewer is capped because its cost is superlinear in turns: every turn
 * re-reads the whole context, so a 150k-token review at 52 turns bills ~7.9M
 * input tokens. 60 is a backstop, not a squeeze — it sits just above the worst
 * review measured (52) so a runaway is bounded while a normal one is untouched.
 * The run is TOLD its budget (see the harness runner), so the saving comes from
 * it planning against the cap rather than from the cap cutting it off.
 */
const CLAUDE_CODE_MAX_TURNS: Record<ClaudeCodeModelClass, number | null> = {
  default: null,
  reviewer: 60,
  conflict: 60,
};

/**
 * Keeps MCP tool schemas OUT of the turn-1 prompt.
 *
 * The harness mounts an org's connections without `alwaysLoad` so their tools
 * stay behind Claude Code's tool search (see `mcpServersFor` in the harness
 * runner) — but that only happens when tool search is ON, and the CLI turns it
 * off by default against a non-first-party `ANTHROPIC_BASE_URL`, which is every
 * OpenRouter and Deco-gateway run. Those runs therefore loaded every mounted
 * tool eagerly: one production org's 22 connections came to ~1.5MB of schemas
 * (VTEX's `tools/list` alone is 990KB) and failed every run on `Prompt is too
 * long` before its first tool call.
 *
 * Set on every shape rather than only the proxied ones: a first-party
 * credential already defers by default, so this is a no-op there, and one code
 * path beats a provider matrix that has to be kept in sync with the CLI's own
 * default.
 *
 * Verified against real OpenRouter rather than assumed, because the mechanism
 * is not what its name suggests. Claude Code does tool search CLIENT-side: it
 * withholds the deferred tools itself and offers an ordinary `ToolSearch`
 * function tool it answers locally. The only thing on the wire is
 * `defer_loading: true` on a single `DeferredToolPlaceholder`, alongside the
 * loaded tools — so none of OpenRouter's server-tool variants
 * (`tool_search_tool_regex_20251119`, and the `bm25` one it rejects) is ever
 * requested. Anthropic models through OpenRouter accept that shape and honour
 * the deferral; the one rule is that at least one tool stay loaded, which the
 * CLI's own always-loaded set satisfies.
 */
const TOOL_SEARCH = "1";

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
  /** Properties of the run, not of the credential — so every shape carries them.
   *  `null` deletes the turn cap, so a sandbox that last ran a reviewer does not
   *  carry that cap into a Super Agent run. */
  const maxTurns = CLAUDE_CODE_MAX_TURNS[modelClass];
  const budget = {
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: `${CLAUDE_CODE_MAX_OUTPUT_TOKENS}`,
    CLAUDE_CODE_MAX_TURNS: maxTurns === null ? null : `${maxTurns}`,
    ENABLE_TOOL_SEARCH: TOOL_SEARCH,
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
