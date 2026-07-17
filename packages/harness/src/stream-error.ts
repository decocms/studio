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
    /insufficient|no credits|out of credits|balance|payment|quota exceeded|key limit|402/i.test(
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
 * Pull a human-readable message + HTTP status out of an unknown error.
 * Gateway/provider errors frequently arrive as plain objects rather than
 * `Error` instances (e.g. the `{ code, message, metadata }` shape a 504 idle
 * timeout carries), so we look past `instanceof Error` and read a string
 * `message` field. `statusCode` falls back to a numeric `code` so the credits
 * (402) detection below works on both shapes.
 */
function extractErrorParts(error: unknown): {
  message: string;
  statusCode?: number;
} {
  if (error instanceof Error) {
    return {
      message: error.message,
      statusCode: (error as { statusCode?: number }).statusCode,
    };
  }
  if (typeof error === "object" && error !== null) {
    const obj = error as {
      message?: unknown;
      statusCode?: unknown;
      code?: unknown;
    };
    const message =
      typeof obj.message === "string" ? obj.message : stringifyError(error);
    const statusCode =
      typeof obj.statusCode === "number"
        ? obj.statusCode
        : typeof obj.code === "number"
          ? obj.code
          : undefined;
    return { message, statusCode };
  }
  return { message: String(error) };
}

/**
 * Whether an error is an account-level credit/billing rejection (402 and
 * friends). Shared by `sanitizeStreamError` (UI `[CREDITS]` tagging) and the
 * free-model fallback middleware (`mesh-provider.ts`) so the two never drift.
 */
export function isCreditError(error: unknown): boolean {
  const { message, statusCode } = extractErrorParts(error);
  const lower = message.toLowerCase();
  return (
    statusCode === 402 ||
    lower.includes("credit") ||
    lower.includes("insufficient funds") ||
    lower.includes("insufficient balance") ||
    lower.includes("billing") ||
    lower.includes("quota exceeded") ||
    lower.includes("key limit") ||
    lower.includes("payment required")
  );
}

/**
 * Downstream MCP connection failures reach the chat as raw transport strings:
 * the SDK's `"Streamable HTTP error: Error POSTing to endpoint: {...-32000...
 * Unauthorized...}"` or our circuit-breaker's `"... circuit breaker is open —
 * downstream server unreachable"`. Neither is meaningful to a user, and the
 * model parrots them back verbatim. Map the known shapes to a short, actionable
 * sentence; return null for anything else so provider/model errors (including
 * genuine model-provider 401s) fall through unchanged.
 */
export function mcpConnectionErrorMessage(message: string): string | null {
  const lower = message.toLowerCase();
  if (lower.includes("circuit breaker is open")) {
    return "A connected app is temporarily unreachable — it'll keep retrying. Try again in a moment.";
  }
  // Gate the auth/reach mapping on the MCP transport markers so a model-provider
  // auth failure (a bad API key) is never mislabeled as a connection problem.
  const isMcpTransport =
    lower.includes("error posting to endpoint") ||
    lower.includes("streamable http error");
  if (!isMcpTransport) return null;
  if (
    /unauthorized|authentication required|forbidden|\b401\b|\b403\b/.test(lower)
  ) {
    return "A connected app needs to be re-authenticated before it can be used. Reconnect it, then try again.";
  }
  return "Couldn't reach a connected app. Try again in a moment.";
}

/**
 * Returns a sanitized, user-facing error message.
 * Provider-specific URLs and branding are stripped so they are never
 * surfaced to the client.
 */
// TODO @pedrofrxncx: remove this code in favor of a better solution
export function sanitizeStreamError(error: unknown): string {
  const { message } = extractErrorParts(error);
  const connectionMsg = mcpConnectionErrorMessage(message);
  if (connectionMsg) return connectionMsg;
  if (isCreditError(error)) {
    // Prefix with [CREDITS] so the frontend can detect credit errors
    // without fragile string matching on provider-specific messages.
    return `[CREDITS] ${stripProviderSpecificDetails(message)}`;
  }
  return stripProviderSpecificDetails(message);
}
