/**
 * Shared GitHub GraphQL transport for the app-only GitHub tools. Every one of
 * them needs the same five things and gets them exactly once here: the
 * org-ownership guard on the connection, the minted token, the single 401
 * refresh-and-retry, the not-JSON-despite-200 guard, and the
 * errors-inside-a-200 guard that plain `res.ok` misses.
 *
 * GraphQL is metered against a budget SEPARATE from REST's (points/hour vs
 * requests/hour) — moving a read here spends a quota REST is not competing for.
 */

import { retry } from "@decocms/shared/std";
import type { StudioContext } from "@/core/studio-context";
import {
  githubConnectionAccessToken,
  isGithubConnection,
} from "@/oauth/github-mint";
import { RECONNECT_ERROR } from "@/oauth/token-refresh";
import {
  countGithubRateLimited,
  githubRetryAfterMs,
  isGithubRateLimited,
  recordGithubRateLimit,
} from "@/observability/github-rate-limit";

/** e2e seam, mirroring `decofile/github-git-data.ts`. Read per call site so a
 *  long-lived dev server and a test webServer agree on one value. */
function githubGraphqlUrl(): string {
  return process.env.GITHUB_GRAPHQL_URL ?? "https://api.github.com/graphql";
}

/** Matches the Git Data client's per-attempt timeout. */
const GITHUB_TIMEOUT_MS = 15_000;

/** A GitHub-side outage, not a real answer — worth retrying, unlike a 4xx. */
export function isGithubTransientServerError(status: number): boolean {
  return status >= 500 && status < 600;
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

/**
 * Resolve a GitHub connection the caller's org owns. A connection id is
 * caller-supplied, so it is re-read scoped to the authenticated org before its
 * credential is used — no cross-org token reads (as GITHUB_LIST_USER_ORGS does).
 */
async function resolveGithubConnection(
  ctx: StudioContext,
  connectionId: string,
) {
  const organizationId = ctx.organization?.id;
  if (!organizationId) {
    throw new Error("Organization context required");
  }
  const connection = await ctx.storage.connections.findById(
    connectionId,
    organizationId,
  );
  if (!connection) {
    throw new Error("Connection not found");
  }
  if (!isGithubConnection(connection)) {
    throw new Error("Connection is not a GitHub connection");
  }
  return connection;
}

/**
 * POST one GraphQL operation on behalf of a connection and return its `data`.
 *
 * `label` names the operation in every error message — it is what tells a
 * reader whether "not accessible" came from a branch search or a PR read.
 *
 * `operation` is the metrics tag, kept separate from `label`: every call site's
 * `label` interpolates the caller-supplied owner/repo/branch, and feeding that
 * straight into an OTel attribute would mint one time series per repo/branch
 * ever queried. `operation` is a fixed, small-cardinality name instead
 * ("pr_state", not "pull request state for acme/site@my-branch").
 */
export async function githubGraphql<T>(
  ctx: StudioContext,
  args: {
    connectionId: string;
    query: string;
    variables: Record<string, unknown>;
    label: string;
    operation: string;
  },
): Promise<T> {
  const connection = await resolveGithubConnection(ctx, args.connectionId);

  const accessToken = await githubConnectionAccessToken(ctx, connection);
  if (!accessToken) {
    throw new Error(RECONNECT_ERROR);
  }

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
  const postWithRetry = (token: string) =>
    retry(
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

  let res = await postWithRetry(accessToken);

  // Token revoked/rotated behind our clock: one refresh + retry, then give up.
  if (res.status === 401) {
    // Drain the discarded 401 body so its connection is released.
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    const refreshed = await githubConnectionAccessToken(ctx, connection, {
      forceRefresh: true,
    });
    if (!refreshed) {
      throw new Error(RECONNECT_ERROR);
    }
    res = await postWithRetry(refreshed);
    if (res.status === 401) {
      throw new Error(RECONNECT_ERROR);
    }
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
