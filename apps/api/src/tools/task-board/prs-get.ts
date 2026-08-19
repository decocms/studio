import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";
import type { StudioContext } from "@/core/studio-context";
import type { ConnectionEntity } from "@/tools/connection/schema";
import { clientFromConnection } from "@/mcp-clients";
import type { TaskBoardItemPrRef } from "@/storage/types";
import { getRepoScope } from "@decocms/shared/github-repo-scope";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import { retry, RetryError } from "@decocms/shared/std";
import { InMemoryMcpReadCache } from "@/mcp-clients/mcp-read-cache";
import { TaskBoardItemPrSchema } from "./schema";
import { recordTaskActivity } from "./activity";
import { emitTaskBoardUpdated } from "./run-reactions";
import { enqueueEnabledReviewers } from "./enqueue-reviewer";
import { reactToApprovedPrConflict } from "./conflict-reaction";
import { readPrStateThrottled } from "./dbos-github-read";

/** Cap a single live PR fetch — the modal shouldn't hang on a slow GitHub. */
const PR_FETCH_TIMEOUT_MS = 8000;

/**
 * GitHub answers "too many requests" — the primary or (more often here) the
 * SECONDARY rate limit, which punishes bursts of concurrent calls rather than a
 * raw hourly count. Retrying that is not a retry, it's the burst: it triples the
 * very thing being limited, and the retried calls are what keep the limit shut.
 * So a rate-limit answer ends the attempt immediately and the cache below serves
 * the last good value instead.
 *
 * Matched on the message because the answer arrives as an MCP tool result
 * (`isError` + text), not an HTTP status we can read. Exported for the unit test.
 */
export function isRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  // Scrub the request URL first: a `429` in `…/pulls/429/merge` is not a status.
  const withoutUrls = message.replace(/https?:\/\/\S+/gi, " ");
  return /too many requests|rate limit|\b429\b/i.test(withoutUrls);
}

/**
 * Stale-while-revalidate cache for the PR reads on the POLLED paths — the task
 * dialog's 60s refresh and the review sweeper — which is where the GitHub 429s
 * came from. Each poll costs four `pull_request_read` calls per PR plus one
 * `GET_CHECK_RUN` per failing check, uncached: `clientFromConnection` (what this
 * file uses) bypasses the proxy's read cache entirely, so every viewer, every
 * poll, every replica hit GitHub live.
 *
 * SWR is what keeps the UI alive: past `revalidateAfterMs` a poll is served from
 * the entry it already has while ONE background call refreshes it (single-flight
 * — concurrent viewers of the same PR collapse into one), and a failed refresh
 * keeps serving the previous value until `maxStaleMs`. So a rate-limit window
 * shows the last known PR state instead of blanking the card to all-nulls.
 *
 * `maxStaleMs` is deliberately much longer than the poll: it only matters while
 * GitHub is refusing us, and half an hour of "the state as of when GitHub last
 * answered" beats an empty card that loses its checks, preview and ship button.
 *
 * Its own instance, not the shared `getMcpReadCache()`: that one is tuned for
 * proxied tool calls (30s/5min) and is settings-gated off in development, and
 * this path wants a longer stale window and to work the same everywhere.
 *
 * ponytail: per-pod, so N replicas still cost N fetches per window. Move it to
 * NATS KV if that's still too many.
 */
const PR_READ_CACHE_ENTRY = {
  /** Just under the dialog's 60s poll, so a poll refreshes rather than blocks. */
  revalidateAfterMs: 55_000,
  /** How long a rate-limit window may be papered over with the last good read. */
  maxStaleMs: 30 * 60_000,
  maxValueBytes: 512 * 1024,
} as const;
const prReadCache = new InMemoryMcpReadCache({
  "tools/call": PR_READ_CACHE_ENTRY,
  "resources/read": PR_READ_CACHE_ENTRY,
  "prompts/get": PR_READ_CACHE_ENTRY,
});

/**
 * Drop this connection's cached PR reads. Call it after WRITING to GitHub
 * through the connection (a merge), so the next poll sees the new state instead
 * of serving the pre-merge one for the rest of the revalidate window — the card
 * only moves to Done once a poll observes `merged`, and a minute of "did my ship
 * button work?" is exactly the confusion this cache must not introduce.
 */
export function invalidatePrReads(connectionId: string): void {
  prReadCache.invalidate(connectionId);
}

/** `owner/repo#number`, for log lines. */
const prLabel = (pr: TaskBoardItemPrRef) =>
  `${pr.repoOwner}/${pr.repoName}#${pr.number}`;

/**
 * One cached, best-effort GitHub read for a PR. Best-effort in the same sense as
 * the rest of this file: `null` on any failure, so the card still renders.
 *
 * `callTool` RESOLVES (doesn't reject) on an upstream MCP error, so an `isError`
 * result is rethrown here — otherwise the cache would happily store GitHub's
 * "too many requests" as the PR's state and serve it for half an hour.
 */
async function cachedPrRead(
  client: Awaited<ReturnType<typeof clientFromConnection>>,
  connectionId: string,
  name: string,
  args: Record<string, unknown>,
  describe: string,
  pending: Promise<void>[],
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await prReadCache.fetch({
      type: "tools/call",
      connectionId,
      // The GitHub installation is the connection's, not the caller's, so every
      // org member reading the same PR shares one entry.
      scope: { kind: "org" },
      params: { name, arguments: args },
      fetchLive: () =>
        retry(
          async () => {
            const result = await client.callTool(
              { name, arguments: args },
              undefined,
              {
                timeout: PR_FETCH_TIMEOUT_MS,
              },
            );
            if (
              result &&
              typeof result === "object" &&
              (result as { isError?: boolean }).isError
            ) {
              throw new Error(
                (result as { content?: Array<{ text?: string }> }).content?.[0]
                  ?.text ?? `${name} returned isError`,
              );
            }
            return result;
          },
          {
            maxAttempts: 3,
            minTimeout: 300,
            maxTimeout: 3000,
            jitter: 1,
            isRetriable: (err) => !isRateLimitError(err),
          },
        ),
      // A background revalidation runs on `client` AFTER this call returns the
      // stale value — so the caller must keep the client open until it settles.
      onRevalidation: (promise) => pending.push(promise),
    });
    return toolResultJson(raw);
  } catch (err) {
    const cause = err instanceof RetryError ? err.cause : err;
    console.error(`[task-board] ${name} failed for ${describe}:`, cause);
    return null;
  }
}

/**
 * The GitHub MCP connection to fetch/merge a PR through: the one that opened it
 * when known (MCP path), else pick from the org's `mcp-github` connections
 * (bash path, where no connection was recorded).
 *
 * The pick matters once an org has repo-scoped connections (imported repos /
 * Code Agents): a repo-scoped child's installation only reaches ITS repo, so
 * using it for a different repo's PR fails (empty live state → the card loses
 * its open/checks/preview and the ship button). So prefer, in order: a
 * repo-scoped connection matching THIS PR's repo (guaranteed access), then the
 * broad org-level connection (no `repoScope`, user OAuth over every repo).
 *
 * There is deliberately NO "any active one" last resort when a repo is named. A
 * connection scoped to a DIFFERENT repo cannot reach this PR — its installation
 * token is repo-scoped — so returning it buys nothing and costs everything: the
 * caller can't tell "GitHub said no" from "we asked the wrong GitHub", the live
 * state comes back all-null, and the card silently parks In Review forever. This
 * is not hypothetical — deleting the org's connection for the repo its PRs were
 * opened against stranded 40+ approved cards, because the resolver kept handing
 * back a connection for an unrelated repo. Returning null instead makes the
 * miss loud (`resolveGithubConnection` returning null is logged at each call
 * site) and points at the real fix: connect the repo.
 */
export async function resolveGithubConnection(
  ctx: StudioContext,
  orgId: string,
  connectionId: string | null,
  repo?: { owner: string; name: string },
): Promise<ConnectionEntity | null> {
  if (connectionId) {
    // Org-scope the lookup: this connection's GitHub installation is used to
    // MERGE PRs, so never resolve one from another org (defense-in-depth against
    // a foreign/colliding connectionId reaching a write path).
    const conn = await ctx.storage.connections.findById(connectionId, orgId);
    if (conn && conn.status === "active") return conn;
  }
  const { items } = await ctx.storage.connections.list(orgId, {
    slug: "mcp-github",
  });
  return pickGithubConnection(
    items.filter((c) => c.status === "active"),
    repo,
  );
}

/**
 * The pick itself, pure so the fallback ladder is unit-testable — the rule that
 * a repo-scoped connection for a DIFFERENT repo is never a substitute is the
 * whole point of this function and is invisible from any integration test that
 * doesn't happen to have two scoped connections lying around.
 */
export function pickGithubConnection<
  T extends { metadata?: Record<string, unknown> | null },
>(active: T[], repo?: { owner: string; name: string }): T | null {
  const broad = active.find((c) => getRepoScope(c) === null) ?? null;
  if (!repo) return broad ?? active[0] ?? null;
  const matching = active.find((c) => {
    const scope = getRepoScope(c);
    return scope?.owner === repo.owner && scope?.repo === repo.name;
  });
  // The broad org-level connection (user OAuth, every repo the user can see) is
  // the only legitimate stand-in for a repo we have no scoped connection to.
  return matching ?? broad;
}

/** Normalize a CallToolResult to its JSON object (structuredContent, else the
 *  text content parsed as JSON). Null on error/empty — inlined so a tool never
 *  imports web helpers. */
function toolResultJson(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const r = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (r.isError) return null;
  if (
    r.structuredContent &&
    typeof r.structuredContent === "object" &&
    Object.keys(r.structuredContent).length > 0
  ) {
    return r.structuredContent as Record<string, unknown>;
  }
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export type ChecksStatus = "pending" | "passing" | "failing" | null;

/** One CI check on the PR, for the card's expandable checks footer. `summary`
 *  is the check-run's output markdown, fetched only for FAILING runs (the ones
 *  worth reading) via `GET_CHECK_RUN`; null otherwise. */
export type PrCheck = {
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  summary: string | null;
};

type PrLiveState = {
  title: string | null;
  body: string | null;
  state: "open" | "closed" | null;
  draft: boolean | null;
  merged: boolean | null;
  /** GitHub's `mergeable`: false = conflicts with base, true = clean, null =
   *  not computed yet / unknown. */
  mergeable: boolean | null;
  checksStatus: ChecksStatus;
  checks: PrCheck[];
  previewUrl: string | null;
};

const NO_LIVE_STATE: PrLiveState = {
  title: null,
  body: null,
  state: null,
  draft: null,
  merged: null,
  mergeable: null,
  checksStatus: null,
  checks: [],
  previewUrl: null,
};

/** Whether `url`'s HOST is a known preview-deploy host — a strict hostname
 *  check, NOT a substring match. The preview is lifted from PR comments,
 *  which external contributors can write, and the result is shown as a
 *  trusted "Open preview" button AND handed to the autonomous QA reviewer to
 *  navigate. So a decoy like `https://evil.example.com/x?y=.decocdn.com` must
 *  be rejected. Exported for the unit test. */
export function isTrustedPreviewHost(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    hostname === "deco.site" ||
    hostname.endsWith(".decocdn.com") ||
    hostname.endsWith(".deco-cx.workers.dev") ||
    hostname.endsWith(".deco.site") ||
    hostname.endsWith(".vercel.app") ||
    hostname.endsWith(".preview.vtex.app")
  );
}

/** Pull the preview URL out of a combined-status response's `statuses[]` (a
 *  status whose `target_url` is a trusted preview host). Kept as a cheap
 *  fallback — most providers post the preview in a comment, not a status, so
 *  this usually finds nothing. `null` when none is posted. */
export function extractPreviewUrl(
  obj: Record<string, unknown> | null,
): string | null {
  if (!obj || !Array.isArray(obj.statuses)) return null;
  const previews = obj.statuses
    .map((s) =>
      s && typeof s === "object"
        ? (s as { target_url?: unknown; state?: unknown })
        : null,
    )
    .filter(
      (s): s is { target_url: string; state?: unknown } =>
        !!s &&
        typeof s.target_url === "string" &&
        isTrustedPreviewHost(s.target_url),
    );
  if (previews.length === 0) return null;
  return (
    previews.find((s) => s.state === "success")?.target_url ??
    previews[0]!.target_url
  );
}

/** deco's Cloudflare account subdomain — the middle label of every
 *  `*.workers.dev` preview host these sites deploy to.
 *  ponytail: hardcoded; make it configurable if sites land in another account. */
const WORKERS_DEV_SUBDOMAIN = "deco-cx";

/** Pull the preview URL out of a `get_check_runs` result, derived from
 *  Cloudflare Workers Builds' uploaded version.
 *
 *  Why this is its OWN source: on some Workers the
 *  `cloudflare-workers-and-pages[bot]` PR comment renders with NO "Preview URL"
 *  column at all (deco-sites/demo-storefront does this; deco-sites/decocms-tanstack
 *  does not — same account, same `preview_urls: true`). The version is uploaded
 *  and reachable either way, and its id is always in the check run's summary:
 *
 *      Build ID:   85b63568-6bf1-45d6-9d3b-57a558dee041
 *      Version ID: 1fe1ee18-b8d0-46ea-bdf1-45cef0cd6e4d
 *
 *  → `https://1fe1ee18-demo-storefront.deco-cx.workers.dev`.
 *
 *  Tried FIRST, ahead of the comment scan: it comes from the build that
 *  actually ran for this commit, so it cannot lose to another provider's stale
 *  or dead comment link — demo-storefront's board card pointed at a decobot
 *  `*.decocdn.com` url that times out. `null` when no Workers Builds run has
 *  uploaded a version yet. Exported for the pure-logic unit test. */
export function extractPreviewUrlFromCheckRuns(raw: unknown): string | null {
  const runs = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { check_runs?: unknown })?.check_runs)
      ? (raw as { check_runs: unknown[] }).check_runs
      : [];
  for (const r of runs) {
    if (!r || typeof r !== "object") continue;
    const o = r as { name?: unknown; output?: { summary?: unknown } };
    const worker =
      typeof o.name === "string"
        ? /^Workers Builds:\s*([a-z0-9][a-z0-9-]*)\s*$/i.exec(o.name)?.[1]
        : null;
    if (!worker) continue;
    const summary = o.output?.summary;
    if (typeof summary !== "string") continue;
    const version = /Version ID:\s*([0-9a-f]{8})/i.exec(summary)?.[1];
    if (!version) continue;
    const url = `https://${version}-${worker}.${WORKERS_DEV_SUBDOMAIN}.workers.dev`;
    if (isTrustedPreviewHost(url)) return url;
  }
  return null;
}

/**
 * Pull the preview URL out of a PR's comments — where the deploy bot
 * actually posts it. Known shapes: Cloudflare Workers'
 * `cloudflare-workers-and-pages[bot]` (a table with a "Commit Preview URL" AND a
 * "Branch Preview URL" — prefer the branch one, stable across the PR's commits),
 * deco.cx's `decobot` (a single "Visit Preview" markdown link), and Vercel's
 * `[Preview](url)` markdown link. Accepts the raw `get_comments` result (an
 * array, or `{ comments }`/`{ items }`), sorts newest-first by `updated_at`
 * (falling back to `created_at`, then array order, when absent) so a stale
 * early comment can't win over a later re-deploy. Sorting by `updated_at`
 * rather than `created_at` matters because Vercel/Cloudflare edit a single
 * sticky comment in place on each push — `created_at` stays frozen at the
 * comment's first post, so ranking by it could let an unrelated LATER human
 * comment (that happens to mention a matching host) outrank the bot's
 * freshly-edited one. Scans each body; `null` when none is found. Exported
 * for the pure-logic unit test.
 */
export function extractPreviewUrlFromComments(raw: unknown): string | null {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { comments?: unknown })?.comments)
      ? (raw as { comments: unknown[] }).comments
      : Array.isArray((raw as { items?: unknown })?.items)
        ? (raw as { items: unknown[] }).items
        : [];
  const recency = (c: unknown): number => {
    const obj = c as { updated_at?: unknown; created_at?: unknown };
    return (
      Date.parse(obj?.updated_at as string) ||
      Date.parse(obj?.created_at as string)
    );
  };
  const sorted = list
    .map((c, index) => ({ c, index }))
    .sort((a, b) => {
      const aTime = recency(a.c);
      const bTime = recency(b.c);
      if (Number.isNaN(aTime) || Number.isNaN(bTime)) return a.index - b.index;
      return bTime - aTime;
    })
    .map(({ c }) => c);
  for (const c of sorted) {
    const body =
      c && typeof (c as { body?: unknown }).body === "string"
        ? (c as { body: string }).body
        : "";
    if (!body) continue;
    // Cloudflare's comment carries both a per-commit and a per-branch preview —
    // prefer the branch URL, which stays valid as the PR gets new commits.
    const branch = body.match(/href=['"]([^'"]+)['"][^>]*>\s*Branch Preview/i);
    if (branch?.[1] && isTrustedPreviewHost(branch[1])) return branch[1];
    const url = (body.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? []).find((u) =>
      isTrustedPreviewHost(u),
    );
    if (url) return url;
  }
  return null;
}

/** Pull the preview URL out of a `GET_PREVIEW_DEPLOYMENT` result — the newest
 *  successful GitHub Deployment status's `environmentUrl`, gated through the
 *  same trusted-host check as the other two sources. Some hosts (VTEX FastStore
 *  WebOps) publish the preview ONLY as a deployment — not a status `target_url`
 *  and not a bot comment — so this is the third and last source tried. `null`
 *  when the commit has no deployment with a published url yet (an in-flight
 *  deploy) or the url isn't a trusted host. Exported for the pure-logic unit
 *  test. */
export function extractPreviewUrlFromDeployment(
  obj: Record<string, unknown> | null,
): string | null {
  const url =
    obj && typeof obj.environmentUrl === "string" ? obj.environmentUrl : null;
  return url && isTrustedPreviewHost(url) ? url : null;
}

/** A git commit sha, validated 7–40 hex — also what keeps a malformed value
 *  from reaching the GitHub query the deployment lookup builds from it. */
function asHeadSha(sha: unknown): string | null {
  return typeof sha === "string" && /^[0-9a-fA-F]{7,40}$/.test(sha)
    ? sha
    : null;
}

/** The PR head commit sha from a `pull_request_read get` response's `head.sha`
 *  — the documented, stable source (present regardless of CI), preferred over
 *  {@link headShaFromStatus}. `null` when absent or not a hex sha. Exported for
 *  the pure-logic unit test. */
export function headShaFromPrGet(
  obj: Record<string, unknown> | null,
): string | null {
  const head = obj?.head as { sha?: unknown } | undefined;
  return asHeadSha(head?.sha);
}

/** The PR head commit sha from a combined-status response (`get_status` returns
 *  the head commit's status, which carries its `sha`). A fallback for
 *  {@link headShaFromPrGet} when the `get` read is the one that flaked. `null`
 *  when absent or not a hex sha. Exported for the pure-logic unit test. */
export function headShaFromStatus(
  statusObj: Record<string, unknown> | null,
): string | null {
  return asHeadSha(statusObj?.sha);
}

/** Map a GitHub combined-status `state` to our three-value checks summary.
 *  A response with no statuses (`total_count === 0`) reads as "no checks",
 *  not "pending" — a PR without CI shouldn't look stuck. Exported for the
 *  pure-logic unit test. */
export function toChecksStatus(
  obj: Record<string, unknown> | null,
): ChecksStatus {
  if (!obj) return null;
  const total = typeof obj.total_count === "number" ? obj.total_count : null;
  if (total === 0) return null;
  switch (obj.state) {
    case "success":
      return "passing";
    case "failure":
    case "error":
      return "failing";
    case "pending":
      return "pending";
    default:
      return null;
  }
}

/** Check-run conclusions that mean the run failed. */
const FAILED_CHECK_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale",
]);

/** Map GitHub check-runs (Checks API) to our three-value summary. Repos on
 *  GitHub Actions post check-runs, NOT legacy commit statuses (which
 *  `toChecksStatus` reads), so this is often the only signal — e.g. a deco site
 *  whose combined status is empty but whose "Deco / QA" check-run failed.
 *  Accepts the raw `get_check_runs` result (`{ check_runs }` or an array).
 *  `null` when there are no check-runs. Exported for the unit test. */
export function toCheckRunsStatus(raw: unknown): ChecksStatus {
  const runs = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { check_runs?: unknown })?.check_runs)
      ? (raw as { check_runs: unknown[] }).check_runs
      : [];
  if (runs.length === 0) return null;
  let failing = false;
  let pending = false;
  for (const r of runs) {
    if (!r || typeof r !== "object") continue;
    const status = (r as { status?: unknown }).status;
    const conclusion = (r as { conclusion?: unknown }).conclusion;
    if (status !== "completed") {
      pending = true;
    } else if (
      typeof conclusion === "string" &&
      FAILED_CHECK_CONCLUSIONS.has(conclusion)
    ) {
      failing = true;
    }
  }
  if (failing) return "failing";
  if (pending) return "pending";
  return "passing";
}

/** Combine two checks summaries, worst-first: failing > pending > passing >
 *  null. A PR's CI can live in BOTH the legacy Status API and the Checks API
 *  (e.g. a Cloudflare deploy status + a GitHub Actions check-run), so we read
 *  both and merge. Exported for the unit test. */
export function mergeChecksStatus(
  a: ChecksStatus,
  b: ChecksStatus,
): ChecksStatus {
  if (a === "failing" || b === "failing") return "failing";
  if (a === "pending" || b === "pending") return "pending";
  if (a === "passing" || b === "passing") return "passing";
  return null;
}

type RawCheckRun = {
  id: number | null;
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
};

/** Parse a `get_check_runs` result into a flat list. Exported for the test. */
export function parseCheckRuns(raw: unknown): RawCheckRun[] {
  const runs = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { check_runs?: unknown })?.check_runs)
      ? (raw as { check_runs: unknown[] }).check_runs
      : [];
  const out: RawCheckRun[] = [];
  for (const r of runs) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    out.push({
      id: typeof o.id === "number" ? o.id : null,
      name: typeof o.name === "string" ? o.name : "",
      status: typeof o.status === "string" ? o.status : "completed",
      conclusion: typeof o.conclusion === "string" ? o.conclusion : null,
      detailsUrl:
        typeof o.html_url === "string"
          ? o.html_url
          : typeof o.details_url === "string"
            ? o.details_url
            : null,
    });
  }
  return out;
}

/** True when a check-run finished in a failing state. */
function isFailingRun(r: RawCheckRun): boolean {
  return (
    r.status === "completed" &&
    r.conclusion != null &&
    FAILED_CHECK_CONCLUSIONS.has(r.conclusion)
  );
}

/** Fetch a check-run's output markdown via the github MCP `GET_CHECK_RUN` tool
 *  (the list tool omits `output`). Best-effort: null on any failure. */
async function fetchCheckRunSummary(
  client: Awaited<ReturnType<typeof clientFromConnection>>,
  connectionId: string,
  pr: TaskBoardItemPrRef,
  checkRunId: number,
  pending: Promise<void>[],
): Promise<string | null> {
  const obj = await cachedPrRead(
    client,
    connectionId,
    "GET_CHECK_RUN",
    { owner: pr.repoOwner, repo: pr.repoName, checkRunId },
    `${prLabel(pr)} check-run ${checkRunId}`,
    pending,
  );
  const output = obj?.output as
    | { summary?: unknown; text?: unknown }
    | undefined;
  const summary = typeof output?.summary === "string" ? output.summary : null;
  const text = typeof output?.text === "string" ? output.text : null;
  return summary ?? text ?? null;
}

/** Just the PR's checks summary (combined status ∪ check-runs) — used to gate
 *  the merge (don't ship on red/pending CI). Best-effort: null when it can't be
 *  determined (which does NOT block the merge — only a definite failing/pending
 *  does). */
export async function fetchPrChecksStatus(
  ctx: StudioContext,
  orgId: string,
  pr: TaskBoardItemPrRef,
): Promise<ChecksStatus> {
  const conn = await resolveGithubConnection(ctx, orgId, pr.connectionId, {
    owner: pr.repoOwner,
    name: pr.repoName,
  });
  if (!conn) return null;
  const client = await clientFromConnection(conn, ctx, true);
  const read = async (method: "get_status" | "get_check_runs") =>
    toolResultJson(
      await client.callTool(
        {
          name: "pull_request_read",
          arguments: {
            method,
            owner: pr.repoOwner,
            repo: pr.repoName,
            pullNumber: pr.number,
          },
        },
        undefined,
        { timeout: PR_FETCH_TIMEOUT_MS },
      ),
    );
  try {
    let status: ChecksStatus = null;
    try {
      status = toChecksStatus(await read("get_status"));
    } catch {
      // best-effort
    }
    try {
      status = mergeChecksStatus(
        status,
        toCheckRunsStatus(await read("get_check_runs")),
      );
    } catch {
      // best-effort
    }
    return status;
  } finally {
    await client.close().catch(() => {});
  }
}

/** Map a `pull_request_read get` response to whether the PR conflicts with its
 *  base branch. `true` = conflicts; `false` = mergeable, OR the PR is not open
 *  (a merged/closed PR reports no mergeability but is never "conflicting");
 *  `null` = GitHub hasn't computed mergeability yet (it's async) or the read
 *  gave nothing — an unknown must NEVER read as a conflict, so the caller only
 *  acts on an explicit `true`. Pure — unit-tested; the single home for the
 *  mergeability polarity, so the two callers can't drift.
 *
 *  `mergeable_state` is the field that actually arrives: `pull_request_read`
 *  returns github-mcp's `MinimalPullRequest`, which has no `mergeable`. Reading
 *  only that boolean yielded `null` for every PR ever, so the conflict
 *  auto-resolution it gates never fired once in production — zero
 *  `merge_conflict_resolution` rows across every org, while an approved,
 *  conflicting PR retried the same 405 every five minutes for two days. The
 *  boolean is still read first: a non-minimal response (a direct GitHub
 *  payload, a different MCP server) carries it and it is the richer signal.
 *
 *  Of the `mergeable_state` values only `dirty` means conflicts; `unknown`/`""`
 *  is GitHub still computing, and the rest (`blocked`, `behind`, `unstable`, …)
 *  are for the checks gate to judge, not this. */
export function conflictFromPrGet(
  obj: Record<string, unknown> | null,
): boolean | null {
  if (!obj) return null;
  if (obj.state !== "open") return false;
  if (typeof obj.mergeable === "boolean") return !obj.mergeable;
  const state = obj.mergeable_state;
  if (typeof state !== "string" || state === "" || state === "unknown") {
    return null;
  }
  return state === "dirty";
}

/** Whether the PR conflicts with its base branch — the definite "can't merge"
 *  signal used to gate conflict auto-resolution. Reads the same `get` the
 *  live-state fetch uses; best-effort (null on any failure). */
export async function fetchPrConflict(
  ctx: StudioContext,
  orgId: string,
  pr: TaskBoardItemPrRef,
): Promise<boolean | null> {
  const conn = await resolveGithubConnection(ctx, orgId, pr.connectionId, {
    owner: pr.repoOwner,
    name: pr.repoName,
  });
  if (!conn) return null;
  const client = await clientFromConnection(conn, ctx, true);
  try {
    return conflictFromPrGet(
      toolResultJson(
        await client.callTool(
          {
            name: "pull_request_read",
            arguments: {
              method: "get",
              owner: pr.repoOwner,
              repo: pr.repoName,
              pullNumber: pr.number,
            },
          },
          undefined,
          { timeout: PR_FETCH_TIMEOUT_MS },
        ),
      ),
    );
  } catch {
    return null;
  } finally {
    await client.close().catch(() => {});
  }
}

/** Fetch the PR's live CI + preview extras via the GitHub MCP
 *  `pull_request_read` tool: the combined Status API AND the Checks API (repos
 *  differ in which they post to), merged into one checks summary, plus the deco
 *  deploy preview URL. Best-effort: any failure yields nulls. */
async function fetchPrStatusExtras(
  client: Awaited<ReturnType<typeof clientFromConnection>>,
  connectionId: string,
  pr: TaskBoardItemPrRef,
  pending: Promise<void>[],
  prGet: Promise<Record<string, unknown> | null>,
): Promise<{
  checksStatus: ChecksStatus;
  checks: PrCheck[];
  previewUrl: string | null;
}> {
  const read = (method: "get_status" | "get_check_runs" | "get_comments") =>
    cachedPrRead(
      client,
      connectionId,
      "pull_request_read",
      {
        method,
        owner: pr.repoOwner,
        repo: pr.repoName,
        pullNumber: pr.number,
      },
      `${prLabel(pr)} (${method})`,
      pending,
    );
  // The three reads are independent — run them CONCURRENTLY. Serial was the
  // slowness (each is a remote MCP → GitHub round-trip, ~1.5-2s; the card made
  // 4-5 of them in a row).
  const [statusObj, runsRaw, commentsRaw] = await Promise.all([
    read("get_status"),
    read("get_check_runs"),
    read("get_comments"),
  ]);
  // Combined Status API ∪ Checks API → one summary.
  const checksStatus = mergeChecksStatus(
    toChecksStatus(statusObj),
    toCheckRunsStatus(runsRaw),
  );
  // Preview: the Workers Builds version (exact, and present even when
  // Cloudflare's PR comment omits its Preview URL column), else a status
  // `target_url` (rare), else the deploy bot's PR comment.
  let previewUrl =
    extractPreviewUrlFromCheckRuns(runsRaw) ??
    extractPreviewUrl(statusObj) ??
    extractPreviewUrlFromComments(commentsRaw);
  // TODO(e2e): cover the miss-path gate + head-sha threading below (only the pure extractors are unit-tested).
  if (!previewUrl) {
    // Last resort: a GitHub Deployment env url (VTEX FastStore posts it only there), scanned only on the miss path once the head sha is known.
    const headSha =
      headShaFromPrGet(await prGet) ?? headShaFromStatus(statusObj);
    if (headSha) {
      previewUrl = extractPreviewUrlFromDeployment(
        await cachedPrRead(
          client,
          connectionId,
          "GET_PREVIEW_DEPLOYMENT",
          { owner: pr.repoOwner, repo: pr.repoName, sha: headSha },
          `${prLabel(pr)} (deployment preview)`,
          pending,
        ),
      );
    }
  }
  // Per-check list for the footer; pull the output markdown only for failing
  // runs (bounded, in parallel).
  const checks = await Promise.all(
    parseCheckRuns(runsRaw).map(
      async (r): Promise<PrCheck> => ({
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
        detailsUrl: r.detailsUrl,
        summary:
          isFailingRun(r) && r.id != null
            ? await fetchCheckRunSummary(
                client,
                connectionId,
                pr,
                r.id,
                pending,
              )
            : null,
      }),
    ),
  );
  return { checksStatus, checks, previewUrl };
}

/** Fetch a PR's live state via the GitHub MCP `pull_request_read` tool.
 *  Best-effort: any failure yields nulls so the modal still shows the link. */
/**
 * Is there a PR to dispatch a reviewer at? A PR we positively know is closed or
 * merged is done with; anything else — open, or unknown because GitHub was quiet
 * — is a candidate.
 *
 * Check status does NOT gate this: the reviewers run WITHOUT waiting for CI. The
 * QA reviewer exercises the deploy preview and the Code Reviewer reads the diff,
 * so we start them as soon as there's a PR rather than sitting on a slow or
 * stuck check. Shipping stays safe — the MERGE is gated on green checks
 * separately (`mergeLinkedPr` → `fetchPrChecksStatus`), so nothing merges on red
 * no matter what a reviewer decided.
 *
 * `fetchPrLiveState` is best-effort: every field comes back `null` when the
 * GitHub call fails, which must read as "we could not ask", not "no PR" — a
 * version that required `state === "open"` answered "not ready" for EVERY card
 * the moment GitHub went quiet and silently froze dispatch. Shared with
 * `review-sweeper.ts` so both dispatch paths agree on when a PR is reviewable.
 */
export const prReadyForReview = (
  prs: {
    state: string | null;
    merged: boolean | null;
  }[],
): boolean => reviewCandidates(prs).length > 0;

/** The PRs a reviewer would be dispatched at: a PR is a candidate unless we
 *  positively know it's finished with. One definition, so the readiness gate and
 *  the preview-freshness gate below can't disagree about which PR is in play. */
const reviewCandidates = <
  T extends { state: string | null; merged: boolean | null },
>(
  prs: T[],
): T[] => prs.filter((p) => p.state !== "closed" && p.merged !== true);

/**
 * Does the deploy preview show the PR's HEAD commit? Pure — unit-tested.
 *
 * Only a definite `failing`/`pending` holds QA back. Everything else — no CI
 * configured, GitHub unreadable, or a field a mid-deploy DBOS replay recorded
 * before it existed — is trusted, the same way every other read here treats "we
 * could not ask" as "do not block".
 *
 * It matters because a preview URL outlives the build that produced it. The URL
 * is lifted from a commit status or the deploy bot's PR comment, and the
 * hostname is per-PR (`pr336-<site>.workers.dev`), not per-commit — so when a
 * deploy fails, that URL keeps serving the last build that SUCCEEDED, with a
 * cheerful 200. QA then exercises code the author didn't write, finds the
 * behaviour absent, and requests changes. The verdict looks exactly like a real
 * one, and the Super Agent cannot fix it by changing the code.
 *
 * That is not hypothetical: a site's Workers build broke account-wide for
 * everything after 16:30 one afternoon, and six cards were on course to spend a
 * second five-bounce budget being rejected against the previous night's bytes.
 *
 * Checks are the signal because GitHub attaches them to a COMMIT: head's deploy
 * being green is what makes the preview head's.
 */
export function previewMatchesHead(
  prs: {
    state: string | null;
    merged: boolean | null;
    checksStatus: ChecksStatus;
  }[],
): boolean {
  return reviewCandidates(prs).every(
    (p) => p.checksStatus !== "failing" && p.checksStatus !== "pending",
  );
}

async function fetchPrLiveState(
  ctx: StudioContext,
  orgId: string,
  pr: TaskBoardItemPrRef,
): Promise<PrLiveState> {
  const conn = await resolveGithubConnection(ctx, orgId, pr.connectionId, {
    owner: pr.repoOwner,
    name: pr.repoName,
  });
  if (!conn) return NO_LIVE_STATE;
  const client = await clientFromConnection(conn, ctx, true);
  // Background revalidations started by the read cache below run on `client`,
  // so it may not be closed until they settle — see the `finally`.
  const pending: Promise<void>[] = [];
  try {
    // Fetch the PR's basic state AND its checks/preview extras CONCURRENTLY.
    // An open PR (the common case in the review dialog) is fully populated in a
    // single round-trip window instead of ~5 serial hops; a merged/closed PR
    // wastes the extras, but that's rare here and best-effort.
    // One `get`, shared: it populates the PR fields and feeds the deployment preview its head sha (stable, unlike the flakier `get_status`).
    const prGet = cachedPrRead(
      client,
      conn.id,
      "pull_request_read",
      {
        method: "get",
        owner: pr.repoOwner,
        repo: pr.repoName,
        pullNumber: pr.number,
      },
      `${prLabel(pr)} (get)`,
      pending,
    );
    const [obj, extras] = await Promise.all([
      prGet,
      fetchPrStatusExtras(client, conn.id, pr, pending, prGet),
    ]);
    if (!obj) return NO_LIVE_STATE;
    const rawState = obj.state;
    const isOpen = rawState === "open";
    const conflict = conflictFromPrGet(obj);
    return {
      title: typeof obj.title === "string" ? obj.title : null,
      body: typeof obj.body === "string" ? obj.body : null,
      state: rawState === "closed" ? "closed" : isOpen ? "open" : null,
      draft: typeof obj.draft === "boolean" ? obj.draft : null,
      merged: typeof obj.merged === "boolean" ? obj.merged : null,
      // Same reducer as the auto-resolution gate, so the two can't drift.
      mergeable: isOpen && conflict !== null ? !conflict : null,
      // Checks/preview only mean something for an open PR.
      checksStatus: isOpen ? extras.checksStatus : null,
      checks: isOpen ? extras.checks : [],
      previewUrl: isOpen ? extras.previewUrl : null,
    };
  } catch {
    return NO_LIVE_STATE;
  } finally {
    // Close only once the background revalidations are done, and do NOT await
    // that here — the whole point of serving a stale value is to return without
    // waiting on GitHub. Closing eagerly (which this did) killed every
    // revalidation the moment it started, so a cached entry could never
    // refresh: a PR read before its deploy comment existed showed no preview
    // and no checks until the entry aged out half an hour later.
    void Promise.allSettled(pending).then(() => client.close().catch(() => {}));
  }
}

/**
 * ONE `pull_request_read get`, the whole call. Deliberately NOT
 * `fetchPrLiveState`, which also fetches checks/preview extras (~5 calls per
 * PR): the sweeps read every candidate PR in one go, and that multiplier is
 * exactly what took out the GitHub App's rate limit once already (see
 * `review-sweeper.ts`).
 *
 * Null on any failure, and never read as an answer by callers — an unreachable
 * GitHub means "we could not ask", not "no".
 */
async function fetchPrGet(
  ctx: StudioContext,
  orgId: string,
  pr: TaskBoardItemPrRef,
  label: string,
): Promise<Record<string, unknown> | null> {
  const conn = await resolveGithubConnection(ctx, orgId, pr.connectionId, {
    owner: pr.repoOwner,
    name: pr.repoName,
  });
  if (!conn) return null;
  const client = await clientFromConnection(conn, ctx, true);
  const pending: Promise<void>[] = [];
  try {
    return await cachedPrRead(
      client,
      conn.id,
      "pull_request_read",
      {
        method: "get",
        owner: pr.repoOwner,
        repo: pr.repoName,
        pullNumber: pr.number,
      },
      `${prLabel(pr)} (${label})`,
      pending,
    );
  } catch {
    return null;
  } finally {
    void Promise.allSettled(pending).then(() => client.close().catch(() => {}));
  }
}

/** Just "is this PR merged?", for the archive sweep. */
export async function fetchPrMerged(
  ctx: StudioContext,
  orgId: string,
  pr: TaskBoardItemPrRef,
): Promise<boolean | null> {
  const obj = await fetchPrGet(ctx, orgId, pr, "merged");
  return typeof obj?.merged === "boolean" ? obj.merged : null;
}

/**
 * Exactly what `prReadyForReview` reads, and nothing else.
 *
 * The review sweep used to call `fetchPrLiveState` here — four GitHub calls per
 * PR plus one per failing check — for two booleans. It has cost that since
 * before the check gate was dropped from the dispatch decision, and a red PR
 * parked In Review is swept forever, so it paid the per-failure summaries on
 * every pass in perpetuity.
 */
export async function fetchPrCandidateState(
  ctx: StudioContext,
  orgId: string,
  pr: TaskBoardItemPrRef,
): Promise<{
  state: "open" | "closed" | null;
  merged: boolean | null;
  checksStatus: ChecksStatus;
}> {
  const obj = await fetchPrGet(ctx, orgId, pr, "candidate");
  return {
    state:
      obj?.state === "closed"
        ? "closed"
        : obj?.state === "open"
          ? "open"
          : null,
    merged: typeof obj?.merged === "boolean" ? obj.merged : null,
    checksStatus: checksFromMergeableState(obj?.mergeable_state),
  };
}

/**
 * GitHub's `mergeable_state`, read as a checks summary. Pure — unit-tested.
 *
 * It exists so the SWEEP can tell whether head's checks are green without
 * paying for the two check reads `fetchPrStatusExtras` makes. `mergeable_state`
 * rides along on the `get` the sweep already does, and this sweep's GitHub
 * budget is not notional — a per-card multiplier here is what held the App's
 * rate limit shut for 17 hours once (see `review-sweeper.ts`).
 *
 * Only the two unambiguous values are mapped. `blocked` is deliberately NOT
 * `pending`: it also covers a missing required review, which says nothing about
 * CI, and reading it as a red check would hold QA back on a PR whose deploy is
 * perfectly fine. Everything else — `dirty` (a conflict), `behind`, `unknown`,
 * absent — says nothing about checks and answers `null`.
 */
export function checksFromMergeableState(state: unknown): ChecksStatus {
  if (state === "clean") return "passing";
  if (state === "unstable") return "failing";
  return null;
}

/**
 * Index of the PR the automation should act on, given each linked PR's live
 * state in `listPrs` order (newest first): the newest one not definitively
 * closed, falling back to the newest.
 *
 * `null` (GitHub unreadable) counts as usable — a blip must not silently
 * redirect a merge to an older PR. `states` may be shorter than the PR list,
 * since {@link pickActivePr} stops reading at the first usable one.
 */
export function pickActivePrIndex(
  states: readonly ("open" | "closed" | null)[],
): number {
  const i = states.findIndex((state) => state !== "closed");
  // Every PR read closed — the newest is still the best guess, and the merged
  // ones are handled by the reconcile-to-Done path.
  return i === -1 ? 0 : i;
}

/**
 * Which of a task's linked PRs the automation should act on.
 *
 * `listPrs` is newest-first, and taking `[0]` blindly is wrong once a task has
 * more than one PR — a bounce that opens a fresh PR instead of pushing to the
 * reviewed one leaves the newest link pointing at an abandoned branch, so the
 * merge gate reads ITS red checks and reports `checks_failing` forever while
 * the approved, green PR sits unmerged.
 *
 * `ctx` is unused here on purpose — kept so callers don't need a special case
 * — the read goes through `readPrStateThrottled`, the same rate-limited DBOS
 * queue the review sweep's own candidate pass uses. This runs on every merge
 * attempt and every review decision, not just the sweep's own timer tick, so
 * calling `fetchPrCandidateState` straight at GitHub here would reopen the
 * exact unbounded-reads problem the queue exists to cap.
 */
export async function pickActivePr(
  _ctx: StudioContext,
  orgId: string,
  prs: TaskBoardItemPrRef[],
): Promise<TaskBoardItemPrRef | undefined> {
  if (prs.length <= 1) return prs[0];
  const states: ("open" | "closed" | null)[] = [];
  for (const pr of prs) {
    const { state } = await readPrStateThrottled(orgId, pr);
    states.push(state);
    // Stop at the first usable PR: the common case is one extra read, not one
    // per link, which is what the GitHub rate limit cares about.
    if (state !== "closed") break;
  }
  return prs[pickActivePrIndex(states)];
}

export const TASK_BOARD_ITEM_PRS_GET = defineTool({
  name: "TASK_BOARD_ITEM_PRS_GET",
  description:
    "Get the GitHub pull requests linked to a task board item, each enriched " +
    "with live state (title, open/closed, draft, merged) fetched from GitHub.",
  annotations: {
    title: "Get Task Board Item Pull Requests",
    // Not read-only: as a side effect it moves a task to Done when it observes a
    // merged PR (see the reconcile below). Idempotent — converges to Done.
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    // Reaches out to GitHub for live PR state.
    openWorldHint: true,
  },
  inputSchema: z.object({ taskBoardItemId: z.string() }),
  outputSchema: z.object({ prs: z.array(TaskBoardItemPrSchema) }),
  handler: async ({ taskBoardItemId }, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }
    const item = await ctx.storage.taskBoard.getById(
      taskBoardItemId,
      organizationId,
    );

    const linked = await ctx.storage.taskBoard.listPrs(
      taskBoardItemId,
      organizationId,
    );
    // One GitHub round-trip per linked PR, in parallel, each best-effort.
    const prs = await Promise.all(
      linked.map(async (pr) => {
        const live = await fetchPrLiveState(ctx, organizationId, pr);
        return {
          url: pr.url,
          number: pr.number,
          repoOwner: pr.repoOwner,
          repoName: pr.repoName,
          createdAt: pr.createdAt,
          ...live,
        };
      }),
    );

    // Auto-hand-off to the enabled reviewers: once the Super Agent's PR is In
    // Review and its checks are green — OR it has no checks at all — delegate to
    // each reviewer the org turned on (QA Agent / Code Reviewer). Only a pending
    // or failing run blocks the hand-off; a PR without CI (`checksStatus ===
    // null`) shouldn't sit in review forever. Like the merge→done reconcile
    // below this is reconcile-on-view (no PR webhook), driven by the modal's 10s
    // poll. Gated on assignee === Super Agent so it never fires for a human's
    // manual review; `enqueueEnabledReviewers` is itself idempotent per reviewer
    // per review cycle, so re-polling won't spawn duplicate reviewer runs.
    const openPr = prs.find((p) => p.state === "open" && !p.merged);
    if (
      item &&
      item.status === "in_review" &&
      item.assigneeId === SUPER_AGENT_ASSIGNEE_ID &&
      prReadyForReview(prs)
    ) {
      await enqueueEnabledReviewers(ctx, item, {
        previewMatchesHead: previewMatchesHead(prs),
      }).catch((err) => {
        console.error("[task-board] reviewer auto-handoff failed", err);
      });
    }

    // Auto-resolve a merge conflict on an approved PR: once every enabled
    // reviewer approved but the PR can't merge because it conflicts with its
    // base branch, hand it back to the Super Agent to resolve (gated on the
    // org's `auto_merge` flag, checked inside the reaction). This is the
    // poll-driven safety net — a conflict often appears AFTER approval (the base
    // branch moved on), which the merge attempt at approval time can't see. Run
    // the same `conflictFromPrGet` mapping the review-decision path uses (only an
    // explicit conflict triggers; null/unknown never does). The reaction is
    // idempotent (it bounces the task to In Progress, so the next poll skips).
    const openPrConflict = openPr
      ? conflictFromPrGet({ state: openPr.state, mergeable: openPr.mergeable })
      : null;
    if (
      item &&
      item.status === "in_review" &&
      item.assigneeId === SUPER_AGENT_ASSIGNEE_ID &&
      openPr &&
      openPrConflict === true
    ) {
      // Act on the PR the conflict was detected on (`openPr`), not a re-derived
      // "newest" — a task can have more than one linked PR.
      await reactToApprovedPrConflict(ctx, organizationId, item, {
        pr: { number: openPr.number, url: openPr.url },
        conflict: true,
      }).catch((err) => {
        console.error("[task-board] conflict auto-resolve failed", err);
      });
    }

    // ponytail: reconcile-on-view — there's no GitHub PR webhook, so a merged PR
    // only advances the card to Done when someone opens this modal. Upgrade path:
    // a `pull_request` webhook calling the same forward move. Best-effort; a
    // failure must never break the read. Forward-only: never un-does Done or Archived.
    if (prs.some((p) => p.merged)) {
      try {
        if (item && item.status !== "done" && item.status !== "archived") {
          const updated = await ctx.storage.taskBoard.update(
            taskBoardItemId,
            organizationId,
            { status: "done" },
            item.updatedBy,
          );
          // Every other path that moves a card to Done (the review-decision
          // auto-merge, "Ship to production") logs a `status_changed` timeline
          // entry — this reconcile silently skipped it, so a task auto-completed
          // by a human merging its PR directly on GitHub left no trace of the
          // move in the Activity feed.
          await recordTaskActivity(ctx, {
            taskBoardItemId,
            action: "status_changed",
            actorId: null,
            data: { from: item.status, to: "done" },
          });
          emitTaskBoardUpdated(organizationId, updated);
        }
      } catch (err) {
        console.error("[task-board] merge→done reconcile failed", err);
      }
    }

    return { prs };
  },
});

/**
 * The PR's head branch name (`head.ref`), or null when GitHub can't be reached.
 *
 * Read live rather than stored on the row deliberately: `task_board_item_prs`
 * is written from three places (the MCP `onPrOpened` hook, a bash-output scan,
 * and the sweeper's closing-message scan) and only one of them ever knows the
 * branch. GitHub always does. Null is a first-class answer — the caller falls
 * back to today's fresh-branch behavior rather than guessing a ref and pushing
 * work somewhere nobody is looking.
 */
export async function fetchPrHeadRef(
  ctx: StudioContext,
  orgId: string,
  pr: TaskBoardItemPrRef,
): Promise<string | null> {
  const conn = await resolveGithubConnection(ctx, orgId, pr.connectionId, {
    owner: pr.repoOwner,
    name: pr.repoName,
  });
  if (!conn) return null;
  const client = await clientFromConnection(conn, ctx, true);
  try {
    const obj = toolResultJson(
      await client.callTool(
        {
          name: "pull_request_read",
          arguments: {
            method: "get",
            owner: pr.repoOwner,
            repo: pr.repoName,
            pullNumber: pr.number,
          },
        },
        undefined,
        { timeout: PR_FETCH_TIMEOUT_MS },
      ),
    );
    // Only an OPEN PR's branch is worth reusing: pushing to a merged or closed
    // PR's branch updates nothing anyone will look at, and the re-run's work
    // would be invisible.
    if (!obj || obj.state !== "open") return null;
    const ref = (obj.head as { ref?: unknown } | undefined)?.ref;
    return typeof ref === "string" && ref.length > 0 ? ref : null;
  } catch {
    return null;
  } finally {
    await client.close().catch(() => {});
  }
}
