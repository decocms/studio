import { retry, RetryError } from "@decocms/shared/std";

/** A transient (5xx / 429) status from a retried fetch. */
class TransientFetchError extends Error {}

/**
 * A GET is always safe to retry — no side effect. So a single flaky 5xx/429
 * doesn't fail the whole call. Shared by every adapter's `listModels` fetch
 * (Google, OpenRouter) so the retry/unwrap logic has one home.
 */
export async function fetchWithTransientRetry(
  label: string,
  url: string | URL,
  init: RequestInit,
): Promise<Response> {
  try {
    return await retry(
      async () => {
        const res = await fetch(url, init);
        if (res.status >= 500 || res.status === 429) {
          const body = await res.text().catch(() => "");
          throw new TransientFetchError(
            `${label} failed: ${res.status} ${body}`,
          );
        }
        return res;
      },
      {
        maxAttempts: 3,
        minTimeout: 200,
        maxTimeout: 2_000,
        isRetriable: (err) => err instanceof TransientFetchError,
      },
    );
  } catch (err) {
    if (err instanceof RetryError && err.cause instanceof Error) {
      throw err.cause;
    }
    throw err;
  }
}
