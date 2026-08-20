import { stripLineNumbers } from "@/components/sandbox/preview/file-explorer/utils";
import { classifyCommittedReadStatus } from "./decofile-read-status";

interface RepoFileParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

/**
 * Outcome of a committed-snapshot read. `absent` and `unavailable` both mean
 * "no data", but only `absent` proves the file isn't in the checkout — which is
 * how the Preview gates tell a non-deco repo from a sandbox that isn't up yet.
 */
export type CommittedRead<T> =
  | { kind: "data"; data: T }
  | { kind: "absent" }
  | { kind: "unavailable" };

/**
 * Read a JSON file committed to the repo working tree via the sandbox daemon's
 * file-read proxy. Unlike `/.decofile` and `/live/_meta` (served by the dev
 * server), this works as soon as the daemon is up — before the dev script boots
 * or even when it has crashed — so the CMS can be read (and, since block writes
 * go straight to the FS, edited) without a working preview.
 *
 * Throws on transient daemon-unreachable errors so the caller's query retries.
 */
export async function readCommittedJson<T>(
  params: RepoFileParams,
  path: string,
): Promise<CommittedRead<T>> {
  const url = `/api/${params.orgSlug}/sandbox/${encodeURIComponent(
    params.virtualMcpId,
  )}/${encodeURIComponent(params.branch)}/read`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, full: true }),
  });
  // 400 = file not found: the repo simply doesn't commit this artifact, so
  // there is no committed source to fall back to. Don't retry — and report it
  // as `absent`, which is a proof callers act on (see `decofileErrorStatus`).
  //
  // 404 = the sandbox isn't provisioned yet (proxy/runner "sandbox not found";
  // a healthy daemon returns 400, never 404, for an absent file). This is a
  // transient startup state, not a hard error — report `unavailable` so the
  // caller falls through to its next source / 502-wait and the sandbox
  // lifecycle re-triggers the read once the daemon is up, instead of throwing a
  // non-502 error that gets retried in a tight loop (and, in useLiveMeta, skips
  // the production fallback).
  const kind = classifyCommittedReadStatus(res.status);
  if (kind === "absent") return { kind: "absent" };
  if (kind === "unavailable") return { kind: "unavailable" };
  if (kind === "error") {
    const err = new Error(`Failed to read ${path}: ${res.status}`);
    (err as { status?: number }).status = res.status;
    throw err;
  }
  // The daemon returns line-number-prefixed content ("1\t...\n2\t..."), even
  // with `full: true`, so strip it before parsing. An unparseable body proves
  // nothing about the framework — a corrupt artifact is not an absent one.
  const data = (await res.json()) as { content?: string };
  if (typeof data.content !== "string") return { kind: "unavailable" };
  try {
    return {
      kind: "data",
      data: JSON.parse(stripLineNumbers(data.content)) as T,
    };
  } catch {
    return { kind: "unavailable" };
  }
}
