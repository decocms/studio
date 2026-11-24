/**
 * Where a change request's deploy preview lives: a CI run (a check run or a
 * commit status) or a deployment's environment URL. Both take write access to
 * the repository to post, unlike a comment, so a comment never names the
 * preview: a pull request draft hands the preview its draft grant. Every
 * reader (task board cards, the reviewer, a pull request draft) accepts only
 * the same known hosts.
 */

import type { CheckRun, PreviewState } from "./change-requests";

/** Whether `url`'s HOST is a known preview-deploy host — a strict hostname
 *  check, NOT a substring match: a decoy like
 *  `https://evil.example.com/x?y=.decocdn.com` must be rejected. Exported for
 *  the unit test. */
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

/** A git commit sha, validated 7–40 hex — also what keeps a malformed value
 *  from reaching the deployment lookup built from it. */
export function asHeadSha(sha: unknown): string | null {
  return typeof sha === "string" && /^[0-9a-fA-F]{7,40}$/.test(sha)
    ? sha
    : null;
}

/**
 * An open change request's preview as its CI runs link it. Null once it is
 * closed or merged, and when no run names a trusted host (the deployment
 * lookup is the caller's extra read).
 */
export function changeRequestPreviewUrl(detail: {
  state: "open" | "closed" | "merged";
  checkRuns: CheckRun[];
}): string | null {
  if (detail.state !== "open") return null;
  return previewUrlFromChecks(detail.checkRuns);
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
 * Where an open change request's preview stands, from its CI runs: the URL
 * once a run links one, else whether a preview run is still going or failed.
 * `none` when no known preview run exists — a host that reports only
 * deployments needs the deployment read to tell.
 */
export function changeRequestPreview(detail: {
  state: "open" | "closed" | "merged";
  checkRuns: CheckRun[];
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
