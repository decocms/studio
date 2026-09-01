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
  const upstream = upstreamProviderError(error);
  if (upstream) return upstream;
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
 * prop for debugging. Shared by hosted dispatch and ingest paths.
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
 * OpenRouter relays EVERY upstream failure as the same opaque
 * `"Provider returned error"` and puts what actually happened — which upstream
 * served the request, and that upstream's own message — in `metadata`. The AI
 * SDK keeps the whole body on the error (`responseBody`, and `data` for the
 * parsed form) and sets `message` to the opaque half, so reading only `message`
 * throws away the one part of the failure anybody can act on.
 *
 * That discard is why a real production bug hid for a month: 169 identical
 * `400 Provider returned error` over 30 days, every one of them Alibaba
 * rejecting `response_format: json_object` on a prompt with no "json" in it —
 * visible only by opening a pod log and reading the raw error dump.
 *
 * Returns `"[<provider>] <upstream message>"`, or null when the error carries
 * no such body (a non-gateway failure, or a gateway error of its own like a
 * 402 credit limit, whose `message` is already the real one).
 */
export function upstreamProviderError(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const body =
    (error as { responseBody?: unknown; data?: unknown }).data ??
    (error as { responseBody?: unknown }).responseBody;
  const parsed = typeof body === "string" ? safeParse(body) : body;
  if (typeof parsed !== "object" || parsed === null) return null;
  const outer = parsed as {
    error?: { metadata?: unknown };
    metadata?: unknown;
  };
  // Two shapes carry it: `{error:{metadata}}` on the OpenAI-compatible route,
  // `{error, metadata}` on the Anthropic-skin one.
  const metadata = (outer.error?.metadata ?? outer.metadata) as
    | { provider_name?: unknown; raw?: unknown }
    | undefined;
  if (typeof metadata !== "object" || metadata === null) return null;
  const provider =
    typeof metadata.provider_name === "string" ? metadata.provider_name : null;
  const upstream =
    typeof metadata.raw === "string" ? upstreamMessage(metadata.raw) : null;
  if (!provider && !upstream) return null;
  return `[${provider ?? "upstream provider"}] ${upstream ?? "no detail returned"}`;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The upstream's own message out of `metadata.raw`, which is that provider's
 * verbatim error body — JSON on the blocking route, and a single `data: {...}`
 * SSE frame when the request was streaming.
 */
function upstreamMessage(raw: string): string | null {
  const parsed = safeParse(raw.trim().replace(/^data:\s*/, ""));
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as { error?: { message?: unknown }; message?: unknown };
  const message = obj.error?.message ?? obj.message;
  return typeof message === "string" && message.length > 0 ? message : null;
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
  const upstream = upstreamProviderError(error);
  if (error instanceof Error) {
    return {
      message: upstream ?? error.message,
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
      upstream ??
      (typeof obj.message === "string" ? obj.message : stringifyError(error));
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
 * free-model fallback middleware (`studio-provider.ts`) so the two never drift.
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
