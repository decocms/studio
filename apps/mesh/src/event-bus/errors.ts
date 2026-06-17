/**
 * Event Bus Error Classification
 *
 * Identifies non-transient delivery failures where retrying with the same
 * credentials is guaranteed to fail (expired tokens, revoked keys, etc.).
 */

const AUTH_MESSAGE_PATTERNS = [
  "unauthorized",
  "invalid_token",
  "invalid api key",
  "api key required",
  "api-key required",
] as const;

const PERMANENT_MESSAGE_PATTERNS = [
  "tool on_events not found",
  "tool not found",
] as const;

/**
 * Classify whether an error represents a permanent auth failure.
 *
 * Checks structured status/code properties first (most reliable),
 * then falls back to message pattern matching with word-boundary
 * matching for numeric codes to avoid false positives.
 */
export function isAuthError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const obj = error as Record<string, unknown>;
    const status = obj.status ?? obj.code;
    if (status === 401) {
      return true;
    }
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  if (!message) return false;

  const lower = message.toLowerCase();

  if (/\b401\b/.test(lower)) return true;

  return AUTH_MESSAGE_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Classify whether an error represents a permanent, non-retryable failure
 * such as a missing tool (e.g. ON_EVENTS not implemented by the connection).
 */
export function isPermanentError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  if (!message) return false;

  const lower = message.toLowerCase();
  return PERMANENT_MESSAGE_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Thrown when event delivery fails due to a permanent issue.
 * The worker skips retries — retrying will not help.
 */
export class PermanentDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentDeliveryError";
  }
}
