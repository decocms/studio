import { BROWSERLESS_FETCH_TIMEOUT_MS } from "./constants";

export type BrowserlessFetchResult =
  | { ok: true; response: Response }
  | { ok: false; error: string };

/**
 * Human-readable reason for a Browserless call that never produced a response.
 * `label` names the call ("Browserless content fetch", "Browserless function
 * call") so the message reads the same at every call site.
 */
export function browserlessFetchErrorMessage(
  label: string,
  err: unknown,
): string {
  if (err instanceof Error && err.name === "TimeoutError") {
    return `${label} timed out after ${BROWSERLESS_FETCH_TIMEOUT_MS}ms`;
  }
  return `${label} failed: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * `fetch` bounded by BROWSERLESS_FETCH_TIMEOUT_MS. Transport failures come back
 * as a value instead of a throw so tool handlers can return a graceful result.
 */
export async function browserlessFetch(
  label: string,
  url: string,
  init: Omit<RequestInit, "signal">,
): Promise<BrowserlessFetchResult> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(BROWSERLESS_FETCH_TIMEOUT_MS),
    });
    return { ok: true, response };
  } catch (err) {
    return { ok: false, error: browserlessFetchErrorMessage(label, err) };
  }
}
