/**
 * GitHub REST plumbing shared by the App auth and the provider client: the
 * headers every call sends, the per-call timeout, rate-limit telemetry, and
 * the conversion of a refusal into `GitProviderError`.
 *
 * Nothing here decides *which* token to send — callers pass one. That is the
 * only way the two callers differ: the App auth signs its own JWT, the client
 * presents an installation or user token.
 */

import {
  countGithubRateLimited,
  githubRetryAfterMs,
  isGithubRateLimited,
  recordGithubRateLimit,
} from "@/observability/github-rate-limit";
import { GitProviderError } from "../types";

const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_JSON_ACCEPT = "application/vnd.github+json";
/** Matches the other GitHub REST callers (`tools/github/list-user-orgs.ts`). */
export const GITHUB_TIMEOUT_MS = 15_000;

export interface GithubFetchInit {
  method?: "GET" | "POST";
  /** Sent as `Authorization: Bearer <token>` — App JWTs and tokens alike. */
  token: string;
  accept?: string;
  /** JSON-encoded into the request body. */
  body?: unknown;
  /** Rate-limit telemetry label. */
  operation: string;
  /** Overrides `GITHUB_TIMEOUT_MS` — archive downloads outlive a REST call. */
  timeoutMs?: number;
}

/**
 * One GitHub REST call. Throws `GitProviderError` for a network/timeout
 * failure (`status: 0`) or a rate-limit refusal (with `retryAfterMs`); every
 * other response — including 4xx — is returned so the caller can give 404 and
 * 422 their endpoint-specific meaning.
 */
export async function githubFetch(
  url: string,
  init: GithubFetchInit,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${init.token}`,
    Accept: init.accept ?? GITHUB_JSON_ACCEPT,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? GITHUB_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new GitProviderError({
      provider: "github",
      status: 0,
      message: `GitHub ${init.operation} failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      cause,
    });
  }

  recordGithubRateLimit(res.headers, {
    lane: "rest",
    operation: init.operation,
  });

  if (isGithubRateLimited(res)) {
    const kind =
      res.headers.get("retry-after") !== null ? "secondary" : "primary";
    countGithubRateLimited({ lane: "rest", operation: init.operation, kind });
    const retryAfterMs = githubRetryAfterMs(res.headers);
    throw new GitProviderError({
      provider: "github",
      status: res.status,
      retryAfterMs,
      message: `GitHub ${kind} rate limit reached${
        retryAfterMs === null
          ? ""
          : `; retry in ${Math.ceil(retryAfterMs / 1000)}s`
      }`,
    });
  }

  return res;
}

/** The `message` GitHub puts in JSON error bodies, else the truncated raw body. Pure. */
export function githubErrorMessage(bodyText: string): string {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "message" in parsed &&
      typeof parsed.message === "string" &&
      parsed.message.length > 0
    ) {
      return parsed.message;
    }
  } catch {
    // Not JSON — an HTML outage page, an empty body. Fall through to the raw text.
  }
  return bodyText.slice(0, 300);
}

/** A `GitProviderError` for a non-2xx response whose body was already read. */
export function githubFailureFromBody(
  status: number,
  bodyText: string,
  operation: string,
): GitProviderError {
  const detail = githubErrorMessage(bodyText);
  return new GitProviderError({
    provider: "github",
    status,
    message: `GitHub ${operation} failed: ${status}${detail ? ` ${detail}` : ""}`,
  });
}

/** A `GitProviderError` for a non-2xx response, reading its body for the message. */
export async function githubFailure(
  res: Response,
  operation: string,
): Promise<GitProviderError> {
  const text = await res.text().catch(() => "");
  return githubFailureFromBody(res.status, text, operation);
}

/**
 * Parse a 2xx body. A proxy or outage page can still answer 200 with HTML,
 * and `res.json()` throwing a raw `SyntaxError` on that would surface as an
 * opaque "Unexpected token" instead of naming what failed.
 */
export async function githubJson<T>(
  res: Response,
  operation: string,
): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new GitProviderError({
      provider: "github",
      status: res.status,
      message: `GitHub ${operation} returned invalid JSON: ${text.slice(0, 300)}`,
      cause,
    });
  }
}
