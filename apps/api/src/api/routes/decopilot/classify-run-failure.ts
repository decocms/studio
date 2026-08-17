/**
 * Turn a failed run's error text into a `failure_kind` you can GROUP BY.
 *
 * Every error failure used to persist one string — "Run ended with an error —
 * see the run's messages" — on 258 of 310 failed task-board threads. It is true
 * and useless: the only way to learn why runs were dying was to leave the thread
 * row entirely and mine `thread_message_parts`, which is how the single biggest
 * failure cause in production (a 402 the harness provoked by asking for a fixed
 * 64k `max_tokens`) went unnoticed. A kind on the row makes that a query.
 *
 * The kinds are the classes seen in production, not a taxonomy invented up
 * front. Unclassified text keeps today's behavior exactly, so this can only add
 * resolution, never lose it.
 */

/** Ordered: the first pattern that matches wins, so put the specific first. */
const FAILURE_PATTERNS: ReadonlyArray<{
  kind: string;
  reason: string;
  match: RegExp;
}> = [
  {
    kind: "credits",
    reason: "Run stopped: the organization is out of AI credits",
    match: /\[CREDITS\]|requires more credits|\b402\b/i,
  },
  {
    kind: "sandbox_unreachable",
    reason: "Run stopped: its sandbox became unreachable mid-run",
    match: /\[SANDBOX_UNREACHABLE\]|sandbox stream broke/i,
  },
  {
    kind: "cancelled",
    reason: "Run cancelled before it finished",
    match: /^\s*(error:\s*)?cancelled\b|run cancelled/i,
  },
  {
    kind: "overloaded",
    reason: "Run stopped: the model provider was overloaded or rate-limited",
    match: /\boverloaded\b|\brate.?limit|\b429\b/i,
  },
  {
    kind: "context_length",
    reason: "Run stopped: the conversation exceeded the model's context window",
    match: /context (length|window)|too many tokens|maximum context/i,
  },
  {
    kind: "model_error",
    reason: "Run stopped: the model provider rejected the request",
    match: /\bAPI Error\b|\b5\d{2}\b.*provider|provider returned/i,
  },
];

/** What today's unclassified failure persists — unchanged, so an error this
 *  does not recognize reads exactly as it did before. */
export const GENERIC_RUN_FAILURE = {
  kind: "error",
  reason: "Run ended with an error — see the run's messages",
} as const;

/**
 * Classify a run failure from its error text. Falls back to
 * {@link GENERIC_RUN_FAILURE} for empty or unrecognized text. Pure.
 */
export function classifyRunFailure(errorText: string | null | undefined): {
  kind: string;
  reason: string;
} {
  if (!errorText?.trim()) return { ...GENERIC_RUN_FAILURE };
  for (const { kind, reason, match } of FAILURE_PATTERNS) {
    if (match.test(errorText)) return { kind, reason };
  }
  return { ...GENERIC_RUN_FAILURE };
}
