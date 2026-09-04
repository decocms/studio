/**
 * GitHub GraphQL transport, over a token rather than a connection.
 *
 * Every caller needs the same four things and gets them exactly once here: the
 * single 401 refresh-and-retry, the retry on a 5xx, the not-JSON-despite-200
 * guard, and the errors-inside-a-200 guard that plain `res.ok` misses.
 *
 * GraphQL is metered against a budget SEPARATE from REST's (points/hour vs
 * requests/hour), so a read moved here spends a quota REST is not competing
 * for. That is the only reason this exists next to `http.ts`.
 *
 * Nothing here decides WHICH token to send: callers pass a getter, which is
 * what lets one transport serve both a git provider account and a legacy
 * connection.
 */

import { retry, RetryError } from "@decocms/shared/std";
import {
  countGithubRateLimited,
  githubRetryAfterMs,
  isGithubRateLimited,
  recordGithubRateLimit,
} from "@/observability/github-rate-limit";

/** e2e seam, mirroring `git-providers/content/github.ts`. Read per call site so a
 *  long-lived dev server and a test webServer agree on one value. */
function githubGraphqlUrl(): string {
  return process.env.GITHUB_GRAPHQL_URL ?? "https://api.github.com/graphql";
}

/** Matches the REST client's per-attempt timeout. */
const GITHUB_TIMEOUT_MS = 15_000;

/** A GitHub-side outage, not a real answer — worth retrying, unlike a 4xx. */
export function isGithubTransientServerError(status: number): boolean {
  return status >= 500 && status < 600;
}

/** Surface the last real failure instead of RetryError's generic message. */
export function unwrapRetryError(error: unknown): unknown {
  return error instanceof RetryError ? error.cause : error;
}

export interface GraphqlEnvelope<T> {
  data?: T | null;
  errors?: Array<{ message?: string }>;
}

/**
 * A 2xx response body isn't guaranteed to be JSON (a proxy/outage page can
 * still answer 200), and `res.json()` throwing a raw `SyntaxError` on that
 * would surface as an opaque "Unexpected token" instead of naming what failed.
 */
export function parseGraphqlBody<T>(
  text: string,
  label: string,
): GraphqlEnvelope<T> {
  try {
    return JSON.parse(text) as GraphqlEnvelope<T>;
  } catch (cause) {
    throw new Error(
      `GitHub GraphQL ${label} returned invalid JSON: ${text.slice(0, 300)}`,
      { cause },
    );
  }
}

/**
 * Unwrap `data`, turning GraphQL's 200-with-`errors` into a throw.
 *
 * Throws rather than returning a plausible empty result when GitHub reported an
 * error, so "no matches" never masks "not allowed to look".
 */
export function unwrapGraphqlData<T>(
  payload: GraphqlEnvelope<T>,
  label: string,
): T {
  const error = payload.errors?.[0]?.message;
  if (error) {
    throw new Error(`GitHub GraphQL ${label} failed: ${error}`);
  }
  if (payload.data == null) {
    throw new Error(`GitHub GraphQL ${label} returned no data`);
  }
  return payload.data;
}

export interface GithubGraphqlArgs {
  /** Returns a bearer token, or null when the credential is gone. `force`
   *  re-mints past any freshness check — used for the one 401 retry. */
  getToken: (force?: boolean) => Promise<string | null>;
  /** Thrown when `getToken` answers null. Callers word this for their surface. */
  missingTokenMessage: string;
  query: string;
  variables: Record<string, unknown>;
  /** Names the operation in every error message, interpolating owner/repo. */
  label: string;
  /**
   * The metrics tag, kept separate from `label`: every call site's `label`
   * interpolates caller-supplied owner/repo/branch, and feeding that straight
   * into an OTel attribute would mint one time series per repo ever queried.
   */
  operation: string;
}

/** POST one GraphQL operation and return its `data`. */
export async function githubGraphqlRequest<T>(
  args: GithubGraphqlArgs,
): Promise<T> {
  const accessToken = await args.getToken();
  if (!accessToken) throw new Error(args.missingTokenMessage);

  const post = (token: string) =>
    fetch(githubGraphqlUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: args.query, variables: args.variables }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });

  // Every call here is a read, so a 5xx (or a fetch that never lands) is safe to retry.
  const postWithRetry = async (token: string) => {
    try {
      return await retry(
        async () => {
          const res = await post(token);
          if (isGithubTransientServerError(res.status)) {
            const status = res.status;
            await res.body?.cancel().catch(() => {});
            throw new Error(`GitHub GraphQL transient error: ${status}`);
          }
          return res;
        },
        { maxAttempts: 3, minTimeout: 300, maxTimeout: 3000, jitter: 1 },
      );
    } catch (error) {
      throw unwrapRetryError(error);
    }
  };

  let res = await postWithRetry(accessToken);

  // Token revoked/rotated behind our clock: one refresh + retry, then give up.
  if (res.status === 401) {
    // Drain the discarded 401 body so its connection is released.
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    const refreshed = await args.getToken(true);
    if (!refreshed) throw new Error(args.missingTokenMessage);
    res = await postWithRetry(refreshed);
    if (res.status === 401) throw new Error(args.missingTokenMessage);
  }

  recordGithubRateLimit(res.headers, {
    lane: "graphql",
    operation: args.operation,
  });

  // Never retried here: retrying a secondary limit IS the burst being limited.
  if (isGithubRateLimited(res)) {
    const kind =
      res.headers.get("retry-after") !== null ? "secondary" : "primary";
    countGithubRateLimited({
      lane: "graphql",
      operation: args.operation,
      kind,
    });
    const waitMs = githubRetryAfterMs(res.headers);
    throw new Error(
      `GitHub ${kind} rate limit reached${
        waitMs === null ? "" : `; retry in ${Math.ceil(waitMs / 1000)}s`
      }`,
    );
  }

  if (!res.ok) {
    throw new Error(`GitHub GraphQL ${args.label} failed: ${res.status}`);
  }

  // GraphQL reports failures as 200 + `errors`, so an ok status isn't enough.
  return unwrapGraphqlData<T>(
    parseGraphqlBody<T>(await res.text(), args.label),
    args.label,
  );
}
