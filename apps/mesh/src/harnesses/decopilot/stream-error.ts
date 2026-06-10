/**
 * Stream Error Helpers
 *
 * Shared error formatting / sanitization used by both `stream-core.ts`
 * (the HTTP-route-level orchestration) and `run-stream.ts` (the
 * decopilot harness's streamText loop). The two layers each call
 * `sanitizeStreamError` from their own `onError` handlers, so the
 * implementations must stay byte-for-byte identical — keep them here
 * to avoid drift.
 */

export function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      return "[unserializable object]";
    }
  }
  return String(error);
}

function stripProviderSpecificDetails(message: string): string {
  const sentences = message.split(/\.\s+/);
  const cleaned = sentences.filter(
    (s) => !/https?:\/\//i.test(s) && !/openrouter/i.test(s),
  );
  if (cleaned.length === 0) return message;
  const result = cleaned.join(". ").trim();
  return result.endsWith(".") ? result : `${result}.`;
}

/**
 * Classify a stream error into a small, stable taxonomy for analytics.
 * Consumers (dashboards) can rely on these values being consistent across
 * providers — the raw error message stays in the separate `error_message`
 * prop for debugging. Shared by dispatch-run (hosted runs) and the link
 * ingest chunk relay (pull runs).
 */
export function classifyStreamError(
  error: unknown,
):
  | "aborted"
  | "insufficient_funds"
  | "rate_limit"
  | "timeout"
  | "auth"
  | "model_error"
  | "tool_error"
  | "unknown" {
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  const msg = (
    error instanceof Error ? error.message : stringifyError(error)
  ).toLowerCase();
  if (
    /insufficient|no credits|out of credits|balance|payment|quota exceeded|402/i.test(
      msg,
    )
  ) {
    return "insufficient_funds";
  }
  if (/rate.?limit|too many requests|429/i.test(msg)) return "rate_limit";
  if (/timeout|timed out|deadline/i.test(msg)) return "timeout";
  if (/unauthor|forbidden|401|403|invalid.*(key|token)/i.test(msg))
    return "auth";
  if (/tool|mcp|connection/i.test(msg)) return "tool_error";
  if (/model|provider|anthropic|openai|gemini|claude/i.test(msg))
    return "model_error";
  return "unknown";
}

/**
 * Returns a sanitized, user-facing error message.
 * Provider-specific URLs and branding are stripped so they are never
 * surfaced to the client.
 */
// TODO @pedrofrxncx: remove this code in favor of a better solution
export function sanitizeStreamError(error: unknown): string {
  if (error instanceof Error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    const msg = error.message.toLowerCase();
    if (
      statusCode === 402 ||
      msg.includes("credit") ||
      msg.includes("insufficient funds") ||
      msg.includes("insufficient balance") ||
      msg.includes("billing") ||
      msg.includes("quota exceeded") ||
      msg.includes("payment required")
    ) {
      // Prefix with [CREDITS] so the frontend can detect credit errors
      // without fragile string matching on provider-specific messages.
      return `[CREDITS] ${stripProviderSpecificDetails(error.message)}`;
    }
    return error.message;
  }
  return stringifyError(error);
}
