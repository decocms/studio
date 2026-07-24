import { stripLineNumbers } from "@/components/sandbox/preview/file-explorer/utils";

interface RepoFileParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

/**
 * Read a JSON file committed to the repo working tree via the sandbox daemon's
 * file-read proxy. Unlike `/.decofile` and `/live/_meta` (served by the dev
 * server), this works as soon as the daemon is up — before the dev script boots
 * or even when it has crashed — so the CMS can be read (and, since block writes
 * go straight to the FS, edited) without a working preview.
 *
 * Returns `null` when the file is absent (daemon 400) or unparseable; throws on
 * transient daemon-unreachable errors so the caller's query retries.
 */
export async function readCommittedJson<T>(
  params: RepoFileParams,
  path: string,
): Promise<T | null> {
  const url = `/api/${params.orgSlug}/sandbox/${encodeURIComponent(
    params.virtualMcpId,
  )}/${encodeURIComponent(params.branch)}/read`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, full: true }),
  });
  // 400 = file not found: the repo simply doesn't commit this artifact, so
  // there is no committed source to fall back to. Don't retry.
  //
  // 404 = the sandbox isn't provisioned yet (proxy/runner "sandbox not found";
  // a healthy daemon returns 400, never 404, for an absent file). This is a
  // transient startup state, not a hard error — return null so the caller falls
  // through to its next source / 502-wait and the sandbox lifecycle re-triggers
  // the read once the daemon is up, instead of throwing a non-502 error that
  // gets retried in a tight loop (and, in useLiveMeta, skips the production
  // fallback).
  if (res.status === 400 || res.status === 404) return null;
  if (!res.ok) {
    const err = new Error(`Failed to read ${path}: ${res.status}`);
    (err as { status?: number }).status = res.status;
    throw err;
  }
  // The daemon returns line-number-prefixed content ("1\t...\n2\t..."), even
  // with `full: true`, so strip it before parsing.
  const data = (await res.json()) as { content?: string };
  if (typeof data.content !== "string") return null;
  try {
    return JSON.parse(stripLineNumbers(data.content)) as T;
  } catch {
    return null;
  }
}
