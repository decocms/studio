import { exponentialBackoffWithJitter } from "@decocms/shared/std";

const RATE_LIMIT_FALLBACK_MS = 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

function retryAfterMs(header: string | null, now: number): number {
  if (header === null || header.trim() === "") return RATE_LIMIT_FALLBACK_MS;
  const value = header.trim();
  const delay = /^\d+(?:\.\d+)?$/.test(value)
    ? Number(value) * 1000
    : /^[A-Za-z]{3}, /.test(value)
      ? Math.max(0, Date.parse(value) - now)
      : Number.NaN;
  return Number.isFinite(delay) && delay >= 0 && delay <= MAX_TIMEOUT_MS
    ? delay
    : RATE_LIMIT_FALLBACK_MS;
}

export class ContentResponseError extends Error {
  readonly retryAt: number | null;

  constructor(
    message: string,
    readonly status: number,
    retryAfter: string | null,
    now = Date.now(),
  ) {
    super(message);
    this.name = "ContentResponseError";
    this.retryAt = status === 429 ? now + retryAfterMs(retryAfter, now) : null;
  }
}

/** Keep the provider's deadline even when normal retries cap at five seconds. */
export function contentReadRetryDelay(
  attempt: number,
  error: unknown,
  now = Date.now(),
): number {
  const backoff = exponentialBackoffWithJitter(5000, 1000, attempt, 2, 0);
  return error instanceof ContentResponseError && error.retryAt !== null
    ? Math.max(backoff, error.retryAt - now)
    : backoff;
}

export async function throwContentResponseError(
  res: Response,
  verb: string,
): Promise<never> {
  const body: unknown = await res.json().catch(() => null);
  const message =
    body !== null &&
    typeof body === "object" &&
    "error" in body &&
    typeof body.error === "string"
      ? body.error
      : `${verb} failed (${res.status})`;
  throw new ContentResponseError(
    message,
    res.status,
    res.headers.get("retry-after"),
  );
}
