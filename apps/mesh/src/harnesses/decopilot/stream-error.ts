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
