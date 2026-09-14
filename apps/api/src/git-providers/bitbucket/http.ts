/**
 * Bitbucket Cloud REST 2.0 plumbing shared by every Bitbucket caller: the API
 * base, the headers and timeout one call sends, the conversion of a refusal
 * into `GitProviderError`, and the paginated envelope every listing uses.
 *
 * Nothing here decides which token to send; callers pass one. Every token
 * Studio stores for Bitbucket — an OAuth access token, a workspace, project
 * or repository access token — is accepted as `Authorization: Bearer`.
 *
 * Bitbucket Cloud only. Bitbucket Data Center (self-hosted) speaks
 * `/rest/api/1.0` with different shapes; `assertBitbucketCloud` refuses such a
 * host up front so the failure is one clear message rather than a trail of
 * confusing 404s.
 */

import { apiBaseUrlFor } from "@decocms/shared/git-providers";
import { GitProviderError } from "../types";
import { BITBUCKET_HOST } from "./env";

/** Matches the other providers: one REST call, not a download. */
const BITBUCKET_TIMEOUT_MS = 15_000;

export const BITBUCKET_API_BASE = apiBaseUrlFor("bitbucket", BITBUCKET_HOST);

/** Bitbucket Cloud is the one host this client speaks. */
export function assertBitbucketCloud(host: string): void {
  if (host.toLowerCase() === BITBUCKET_HOST) return;
  throw new GitProviderError({
    provider: "bitbucket",
    status: 400,
    message: `${host} is not Bitbucket Cloud. Only bitbucket.org is supported; Bitbucket Data Center has a different API.`,
  });
}

/**
 * How long Bitbucket asked us to wait, in ms, or null when it did not say.
 * Bitbucket answers 429 with a `Retry-After` in seconds when it gives a hint
 * at all; there is no reset header. `now` is injected so an HTTP-date form is
 * testable.
 */
export function bitbucketRetryAfterMs(
  headers: Headers,
  now: number = Date.now(),
): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter === null) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(retryAfter);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * The human-readable half of a Bitbucket error body. Two shapes:
 * `{"type": "error", "error": {"message": "...", "detail": "...", "fields":
 * {...}}}` for the REST API, and `{"error": "...", "error_description": "..."}`
 * for OAuth. The conflict classifiers match on this text, so flattening both
 * is load-bearing, not cosmetic.
 */
export function bitbucketErrorMessage(bodyText: string): string {
  const flatten = (value: unknown): string[] => {
    if (typeof value === "string") return value.length > 0 ? [value] : [];
    if (Array.isArray(value)) return value.flatMap(flatten);
    if (value !== null && typeof value === "object") {
      return Object.values(value).flatMap(flatten);
    }
    return [];
  };
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed !== null && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const parts = [
        ...flatten(record.error),
        ...flatten(record.error_description),
      ];
      if (parts.length > 0) return parts.join("; ");
    }
  } catch {
    // Not JSON: an HTML error page or an empty body. Fall through to the text.
  }
  return bodyText.slice(0, 300);
}

/** A `GitProviderError` for a non-2xx response, reading its body for the message. */
export async function bitbucketFailure(
  res: Response,
): Promise<GitProviderError> {
  const text = await res.text().catch(() => "");
  const detail = text ? bitbucketErrorMessage(text) : res.statusText;
  return new GitProviderError({
    provider: "bitbucket",
    status: res.status,
    message: `Bitbucket API ${res.status}: ${detail}`,
    retryAfterMs:
      res.status === 429 ? bitbucketRetryAfterMs(res.headers) : null,
  });
}

/**
 * Parse a response body as JSON, degrading a malformed 2xx body into a
 * `GitProviderError` instead of letting a raw `SyntaxError` escape — mirrors
 * `gitlab/http.ts`'s `gitlabJson`.
 */
export async function bitbucketJson<T>(
  res: Response,
  operation: string,
): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new GitProviderError({
      provider: "bitbucket",
      status: res.status,
      message: `Bitbucket ${operation} returned invalid JSON: ${text.slice(0, 300)}`,
      cause,
    });
  }
}

export interface BitbucketFetchInit {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** A `FormData` is sent as multipart (the `src` commit endpoint); anything else as JSON. */
  body?: unknown;
  accept?: string;
  timeoutMs?: number;
  /**
   * `Basic x-token-auth:<token>` instead of `Bearer` — the web host's
   * archive download authenticates the way `git` does, not the way the API does.
   */
  basicAuth?: boolean;
}

/**
 * One authenticated call. A network or timeout failure becomes a
 * `GitProviderError` with `status: 0`; every response — including 4xx — is
 * returned, so a caller can give 404 and 409 their endpoint-specific meaning.
 */
export async function bitbucketFetch(
  url: string,
  token: string,
  init: BitbucketFetchInit = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: init.basicAuth
      ? `Basic ${Buffer.from(`x-token-auth:${token}`).toString("base64")}`
      : `Bearer ${token}`,
    Accept: init.accept ?? "application/json",
  };
  const multipart = init.body instanceof FormData;
  if (init.body !== undefined && !multipart) {
    headers["Content-Type"] = "application/json";
  }
  try {
    return await fetch(url, {
      method: init.method ?? "GET",
      headers,
      body:
        init.body === undefined
          ? undefined
          : multipart
            ? (init.body as FormData)
            : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? BITBUCKET_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new GitProviderError({
      provider: "bitbucket",
      status: 0,
      message: `Bitbucket request failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      cause,
    });
  }
}

/**
 * Bitbucket's paginated envelope. `next` is a full URL for the following
 * page; `size` is the total and is "optional, not provided in all responses"
 * — refs and commits omit it once counting would cost too much.
 */
export interface BitbucketPage<T> {
  values?: T[] | null;
  next?: string | null;
  size?: number | null;
  page?: number | null;
}

/**
 * The page number `next` points at, or null when the listing is exhausted.
 * Pure — the `next` URL is opaque to callers, but a page NUMBER is what the
 * interface's cursor carries, and what a caller can pass back as `page=`.
 */
export function nextPageNumber(page: BitbucketPage<unknown>): number | null {
  if (!page.next) return null;
  try {
    const raw = new URL(page.next).searchParams.get("page");
    const n = Number(raw);
    return raw !== null && Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * A string literal in Bitbucket's query language (`q=name ~ "foo"`): double
 * quotes and backslashes are the only escapes it understands.
 */
export function bbqString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
