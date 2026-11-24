/**
 * Where a change request's deploy preview lives. Deploy hosts publish it in
 * three places — a CI run, a bot comment, or a deployment's environment URL —
 * and every reader (task board cards, the reviewer, the CMS preview of a pull
 * request draft) must accept only the same known hosts.
 */

import type { CheckRun, PreviewState } from "./change-requests";

/** Whether `url`'s HOST is a known preview-deploy host — a strict hostname
 *  check, NOT a substring match. The preview is lifted from comments, which
 *  external contributors can write, and the result is shown as a trusted
 *  "Open preview" button AND handed to the autonomous QA reviewer to
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
    hostname.endsWith(".vtex.app")
  );
}

/** deco's Cloudflare account subdomain — the middle label of every
 *  `*.workers.dev` preview host these sites deploy to.
 *  ponytail: hardcoded; make it configurable if sites land in another account. */
const WORKERS_DEV_SUBDOMAIN = "deco-cx";

/**
 * The preview URL a CI run points at. Two shapes, both real:
 *
 * - Cloudflare's "Workers Builds: <worker>" run reports the deployed version
 *   in its own summary, which is exact and present even when its comment omits
 *   the preview column;
 * - every other provider just links the deploy from the run (a check run's
 *   details URL, a commit status's target URL).
 *
 * Exported for the pure-logic unit test.
 */
export function previewUrlFromChecks(runs: CheckRun[]): string | null {
  for (const run of runs) {
    const worker = /^Workers Builds:\s*([a-z0-9][a-z0-9-]*)\s*$/i.exec(
      run.name,
    )?.[1];
    const version = run.summary
      ? /Version ID:\s*([0-9a-f]{8})/i.exec(run.summary)?.[1]
      : null;
    if (!worker || !version) continue;
    const url = `https://${version}-${worker}.${WORKERS_DEV_SUBDOMAIN}.workers.dev`;
    if (isTrustedPreviewHost(url)) return url;
  }
  // Any trusted host in a run's link or report; successful runs first, so a retried deploy wins.
  const isSuccess = (run: CheckRun) => run.conclusion === "success";
  for (const run of [
    ...runs.filter(isSuccess),
    ...runs.filter((r) => !isSuccess(r)),
  ]) {
    const url =
      (run.url && isTrustedPreviewHost(run.url) ? run.url : null) ??
      firstTrustedUrl(run.summary);
    if (url) return url;
  }
  return null;
}

/** The first url in `text` on a trusted preview host. The character class stops
 *  at `)`/`]` so a markdown link's url does not absorb its syntax. */
function firstTrustedUrl(text: unknown): string | null {
  if (typeof text !== "string") return null;
  return (
    (text.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? []).find(
      isTrustedPreviewHost,
    ) ?? null
  );
}

/**
 * Pull the preview URL out of the change request's comments — where the deploy
 * bot actually posts it. Known shapes: Cloudflare Workers'
 * `cloudflare-workers-and-pages[bot]` (a table with a "Commit Preview URL" AND
 * a "Branch Preview URL" — prefer the branch one, stable across the change
 * request's commits), deco.cx's `decobot` (a single "Visit Preview" markdown
 * link), and Vercel's `[Preview](url)` markdown link.
 *
 * Sorted newest-first by `updatedAt` (falling back to `createdAt`, then array
 * order), so a stale early comment can't win over a later re-deploy. By
 * `updatedAt` rather than `createdAt` because Vercel and Cloudflare edit ONE
 * sticky comment in place on each push: `createdAt` stays frozen at its first
 * post, so ranking by it could let an unrelated later human comment (that
 * happens to mention a matching host) outrank the bot's freshly edited one.
 * Exported for the pure-logic unit test.
 */
export function previewUrlFromComments(
  comments: { body: string; createdAt?: string; updatedAt?: string }[],
): string | null {
  const recency = (c: { createdAt?: string; updatedAt?: string }): number =>
    Date.parse(c.updatedAt ?? "") || Date.parse(c.createdAt ?? "");
  const sorted = comments
    .map((c, index) => ({ c, index }))
    .sort((a, b) => {
      const aTime = recency(a.c);
      const bTime = recency(b.c);
      if (Number.isNaN(aTime) || Number.isNaN(bTime)) return a.index - b.index;
      return bTime - aTime;
    })
    .map(({ c }) => c);
  for (const comment of sorted) {
    const body = comment.body;
    if (!body) continue;
    // Cloudflare also posts a per-branch preview, which outlives new commits: prefer it.
    const branch = body.match(/href=['"]([^'"]+)['"][^>]*>\s*Branch Preview/i);
    if (branch?.[1] && isTrustedPreviewHost(branch[1])) return branch[1];
    const url = firstTrustedUrl(body);
    if (url) return url;
  }
  return null;
}

/** A git commit sha, validated 7–40 hex — also what keeps a malformed value
 *  from reaching the deployment lookup built from it. */
export function asHeadSha(sha: unknown): string | null {
  return typeof sha === "string" && /^[0-9a-fA-F]{7,40}$/.test(sha)
    ? sha
    : null;
}

/**
 * An open change request's preview, from what its detailed read already holds:
 * a CI run's link first, then a bot comment. Null once it is closed or merged,
 * and when neither names a trusted host (the deployment lookup is the caller's
 * extra read).
 */
export function changeRequestPreviewUrl(detail: {
  state: "open" | "closed" | "merged";
  checkRuns: CheckRun[];
  comments: { body: string; createdAt?: string; updatedAt?: string }[];
}): string | null {
  if (detail.state !== "open") return null;
  return (
    previewUrlFromChecks(detail.checkRuns) ??
    previewUrlFromComments(detail.comments)
  );
}

/** CI runs that deploy the preview: deco's status, Cloudflare Workers Builds,
 *  Vercel, or any run linking a preview host. */
function isPreviewRun(run: CheckRun): boolean {
  return (
    /^deco\/preview$/i.test(run.name) ||
    /^Workers Builds:/i.test(run.name) ||
    /^Vercel\b/i.test(run.name) ||
    (!!run.url && isTrustedPreviewHost(run.url))
  );
}

/**
 * Where an open change request's preview stands, from its detailed read: the
 * URL once a run or comment links one, else whether a preview run is still
 * going or failed. `none` when no known preview run exists — a host that
 * reports only deployments needs the deployment read to tell.
 */
export function changeRequestPreview(detail: {
  state: "open" | "closed" | "merged";
  checkRuns: CheckRun[];
  comments: { body: string; createdAt?: string; updatedAt?: string }[];
}): { state: PreviewState; url: string | null } {
  const url = changeRequestPreviewUrl(detail);
  if (url) return { state: "ready", url };
  if (detail.state !== "open") return { state: "none", url: null };
  const runs = detail.checkRuns.filter(isPreviewRun);
  if (runs.some((run) => run.state !== "completed")) {
    return { state: "building", url: null };
  }
  const failed = runs.some(
    (run) =>
      run.conclusion === "failure" ||
      run.conclusion === "timed_out" ||
      run.conclusion === "cancelled",
  );
  return { state: failed ? "failed" : "none", url: null };
}
