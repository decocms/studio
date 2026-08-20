/**
 * GitHub rate-limit telemetry. Every path that talks to api.github.com competes
 * for ONE budget per installation token; `dbos-github-read.ts` records that
 * budget shutting for 17 hours, and the ceiling it added was sized against an
 * estimate because nothing measured the real thing.
 *
 * `lane` tags the transport, not the caller: the question to answer is which of
 * our ways of reaching GitHub spends the budget. `resource` stays an attribute
 * rather than being collapsed — REST and GraphQL are metered separately
 * (requests/hour vs points/hour) through these same headers, so a remaining
 * count means nothing without knowing which pool it drained.
 */

import type { Counter, Gauge } from "@opentelemetry/api";
import { meter } from "./index";

/** Which transport spent the budget. */
export type GithubLane = "rest" | "graphql";

export interface GithubRateLimitSnapshot {
  limit: number | null;
  remaining: number | null;
  /** Epoch SECONDS at which the window resets, as GitHub reports it. */
  reset: number | null;
  used: number | null;
  /** GitHub's own name for the pool: "core", "graphql", "search", … */
  resource: string | null;
}

function readInt(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Pull the `x-ratelimit-*` family off a response.
 *
 * Exported and pure so the parsing is unit-testable without a metrics SDK —
 * every other export here has a side effect on a live meter.
 */
export function readGithubRateLimit(headers: Headers): GithubRateLimitSnapshot {
  return {
    limit: readInt(headers, "x-ratelimit-limit"),
    remaining: readInt(headers, "x-ratelimit-remaining"),
    reset: readInt(headers, "x-ratelimit-reset"),
    used: readInt(headers, "x-ratelimit-used"),
    resource: headers.get("x-ratelimit-resource"),
  };
}

/**
 * True when the response is GitHub refusing us for rate reasons. A 403 counts
 * only with `retry-after` (secondary limit) or an exhausted primary window — a
 * 403 for missing scopes is a permission problem, and reporting it as a limit
 * would tell the user to wait for a window that will never help.
 */
export function isGithubRateLimited(res: {
  status: number;
  headers: Headers;
}): boolean {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  if (res.headers.get("retry-after") !== null) return true;
  return readInt(res.headers, "x-ratelimit-remaining") === 0;
}

/**
 * How long GitHub asked us to wait, in ms, or null when it did not say.
 * `retry-after` is seconds; `x-ratelimit-reset` is an absolute epoch-seconds
 * instant. `now` is injected so the conversion is testable.
 */
export function githubRetryAfterMs(
  headers: Headers,
  now: number = Date.now(),
): number | null {
  const retryAfter = readInt(headers, "retry-after");
  if (retryAfter !== null) return Math.max(0, retryAfter * 1000);
  const reset = readInt(headers, "x-ratelimit-reset");
  if (reset !== null) return Math.max(0, reset * 1000 - now);
  return null;
}

/** Lazily created so they bind the post-SDK-start meter (`meter` is a live
 *  binding reassigned when the SDK starts — same pattern as disk-cache.ts). */
let remainingGauge: Gauge | null = null;
let usedGauge: Gauge | null = null;
let callCounter: Counter | null = null;
let limitedCounter: Counter | null = null;

/**
 * Record one GitHub response's rate-limit position. A response without the
 * headers still counts the call; nothing here throws into the path it observes.
 */
export function recordGithubRateLimit(
  headers: Headers,
  attrs: { lane: GithubLane; operation: string },
): GithubRateLimitSnapshot {
  const snapshot = readGithubRateLimit(headers);
  const labels = {
    lane: attrs.lane,
    operation: attrs.operation,
    resource: snapshot.resource ?? "unknown",
  };

  callCounter ??= meter.createCounter("github_api_calls", {
    description: "Calls to the GitHub API, by transport and operation",
    unit: "{calls}",
  });
  callCounter.add(1, labels);

  if (snapshot.remaining !== null) {
    remainingGauge ??= meter.createGauge("github_rate_limit_remaining", {
      description: "Requests (REST) or points (GraphQL) left in the window",
      unit: "{requests}",
    });
    remainingGauge.record(snapshot.remaining, labels);
  }
  if (snapshot.used !== null) {
    usedGauge ??= meter.createGauge("github_rate_limit_used", {
      description: "Requests (REST) or points (GraphQL) spent in the window",
      unit: "{requests}",
    });
    usedGauge.record(snapshot.used, labels);
  }

  return snapshot;
}

/**
 * Count a refusal. Separate from {@link recordGithubRateLimit} because a
 * rate-limited response is exactly the one whose headers are least complete.
 */
export function countGithubRateLimited(attrs: {
  lane: GithubLane;
  operation: string;
  /** "primary" when the window is exhausted, "secondary" for a burst refusal. */
  kind: "primary" | "secondary";
}): void {
  limitedCounter ??= meter.createCounter("github_rate_limited", {
    description: "GitHub responses refused for rate-limit reasons",
    unit: "{responses}",
  });
  limitedCounter.add(1, attrs);
}
