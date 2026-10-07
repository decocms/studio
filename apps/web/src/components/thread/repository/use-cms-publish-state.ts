/** The publish popover's read side, in two lanes.
 *
 * The MANIFEST lane is the changed-file list, which rides free on `/git/status`
 * and is already warm in the header — so the popover's real card list, count,
 * gate and enabled button are decided one request in, and usually zero. It
 * suspends; there is nothing to show without it.
 *
 * The BODIES lane is the file contents, which only add section sub-lines and
 * the expanded diff. It never suspends and never blocks the button: a body
 * arriving (or failing) changes what a card SAYS, never which cards exist.
 *
 * Servers that predate the manifest omit `changedFiles`, and the sandbox daemon
 * has no equivalent — then this falls back to deriving everything from the
 * bodies, and a failure to load them is a load error, not an empty list.
 */

import { skipToken, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys.ts";
import {
  summarizePublishChanges,
  summarizePublishManifest,
  type PublishChangeSummary,
} from "./publish-change-summary.ts";
import {
  fetchGitStatus,
  fetchPublishDiff,
  hasGitLocalWork,
  isSandboxUnreachable,
  sandboxGitStatusQueryOptions,
  type GitDiffResult,
  type GitStatus,
} from "./sandbox-git-api.ts";

interface CmsPublishStateArgs {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  threadId: string | null;
  baseBranch: string;
  /** Sandbox-less Fast Preview, answered by the provider API instead of a daemon. */
  fastPreview: boolean;
  /** Re-provisions an unreachable sandbox; the read is retried once after it. */
  recoverSandbox?: () => Promise<unknown>;
}

export interface CmsPublishState {
  status: GitStatus;
  /** Cards to render — complete at the manifest beat, enriched at the bodies beat. */
  summary: PublishChangeSummary;
  /** Every changed path including generated artifacts: what "discard all" reverts. */
  allPaths: string[];
  /** Changed-path count before the server's cap; may exceed `allPaths.length`. */
  changedFilesTotal: number;
  /** The cap dropped paths — never offer an action over the whole set. */
  changedFilesTruncated: boolean;
  /** The head the card list was read from; publish asserts it before mutating. */
  headSha: string | null;
  /** File bodies, or null until (or unless) they load. */
  diff: GitDiffResult | null;
  /** Bodies are still in flight — sub-lines and the expanded diff aren't ready. */
  bodiesPending: boolean;
  /** Bodies failed; the gate falls back to the path rule. */
  bodiesFailed: boolean;
  /** True while the card list itself is unknown (no manifest, bodies pending). */
  cardsPending: boolean;
  /** Re-reads the manifest; the popover calls it after a discard. */
  refresh: () => Promise<unknown>;
}

function cmsPublishBodiesQueryKey(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
  baseBranch: string,
  headSha: string | null,
  localWork: string | null,
) {
  return [
    "cms-publish-bodies",
    orgSlug,
    virtualMcpId,
    branch,
    baseBranch,
    headSha,
    localWork,
  ] as const;
}

/** How long file bodies stay valid. They are content-addressed by `headSha`,
 *  so a new head is a new entry rather than a stale one. */
const BODIES_STALE_MS = 60_000;

/**
 * A sandbox's uncommitted edits never move its head, so its bodies are keyed
 * by the working tree's file list as well — a discard is then a new entry.
 * Null for Fast Preview, which has no working tree.
 */
function localWorkKey(status: GitStatus, fastPreview: boolean): string | null {
  if (fastPreview) return null;
  return status.files
    .map((file) => `${file.index}${file.working_dir} ${file.path}`)
    .sort()
    .join("\n");
}

/**
 * Read-only subscription to the decofile the CMS already loaded. It holds the
 * head content of every block still on the branch, which is what turns a file
 * path into "Home" before a single body has been fetched. `skipToken` makes it
 * a reactive cache read that never issues a request of its own.
 */
function useDecofileHead(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
): Record<string, unknown> | undefined {
  const { data } = useQuery({
    queryKey: KEYS.decofile(`${orgSlug}/${virtualMcpId}/${branch}`),
    queryFn: skipToken,
  });
  return data as Record<string, unknown> | undefined;
}

export function useCmsPublishState(args: CmsPublishStateArgs): CmsPublishState {
  const {
    orgSlug,
    virtualMcpId,
    branch,
    threadId,
    baseBranch,
    fastPreview,
    recoverSandbox,
  } = args;
  const sandboxRef = { orgSlug, virtualMcpId, branch, threadId };
  const call = fastPreview ? { fastPreview: true } : undefined;

  /** The proxy can hold a stale handle while the preview stays live through
   *  the gateway; re-provisioning once is the same self-heal the preview runs. */
  const withRecovery = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      if (!recoverSandbox || !isSandboxUnreachable(error)) throw error;
      await recoverSandbox();
      return read();
    }
  };

  const statusQuery = useSuspenseQuery({
    ...sandboxGitStatusQueryOptions(sandboxRef, call),
    queryFn: () => withRecovery(() => fetchGitStatus(sandboxRef, call)),
  });
  const status = statusQuery.data;
  const manifest = status.changedFiles ?? null;
  const headSha = status.headSha ?? null;

  // Fast Preview's local-work fields are always empty; drift is its only signal.
  const wantsBodies = manifest
    ? manifest.length > 0
    : (status.aheadOfBase ?? 0) > 0 || hasGitLocalWork(status);

  const bodiesQuery = useQuery({
    queryKey: cmsPublishBodiesQueryKey(
      orgSlug,
      virtualMcpId,
      branch,
      baseBranch,
      headSha,
      localWorkKey(status, fastPreview),
    ),
    queryFn: () =>
      withRecovery(() =>
        fetchPublishDiff(sandboxRef, status, baseBranch, call),
      ),
    enabled: wantsBodies,
    // A working tree's contents change under the same key: never reuse them.
    staleTime: fastPreview ? BODIES_STALE_MS : 0,
    gcTime: fastPreview ? undefined : 0,
    // Without a manifest, a failed read must not render as "everything is live".
    throwOnError: !manifest,
  });

  const decofileHead = useDecofileHead(orgSlug, virtualMcpId, branch);

  const diff = bodiesQuery.data ?? null;
  const summary = manifest
    ? summarizePublishManifest({ files: manifest, lookup: decofileHead, diff })
    : summarizePublishChanges(diff);

  return {
    status,
    summary,
    allPaths: manifest
      ? manifest.map((file) => file.path)
      : Object.keys(diff?.diffs ?? {}),
    changedFilesTotal: status.changedFilesTotal ?? summary.count,
    changedFilesTruncated: status.changedFilesTruncated ?? false,
    headSha,
    diff,
    bodiesPending: wantsBodies && bodiesQuery.isPending,
    bodiesFailed: bodiesQuery.isError,
    cardsPending: !manifest && wantsBodies && bodiesQuery.isPending,
    refresh: () => statusQuery.refetch(),
  };
}
