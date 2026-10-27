/**
 * The Releases screen's reads and writes (`/api/:org/hosted/:vmcp/*`): the
 * timeline of main's commits with the ones that have a companion release,
 * what latest.json names ("Latest"), and "Make current" (a new version with
 * an earlier one's content).
 */

import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import { runContentChange } from "@/components/sections-editor/content-sync";
import { useContentSyncTarget } from "@/components/sections-editor/use-content-sync";
import { KEYS } from "@/lib/query-keys";
import {
  type HostedPublishResult,
  retryRelease,
} from "@/components/thread/repository/hosted-publish-api";

export interface ReleasePointer {
  revision: string;
  schemaHash: string;
  publishedAt: string;
}

export interface ReleaseCommit {
  sha: string;
  date: string;
  message: string;
  author: string | null;
  /** Has a companion release on the CDN: it can be reapplied. */
  hasRelease: boolean;
  /** This version reapplied the version of that commit, made at `date`. */
  reapplyOf: { sha: string; date: string | null } | null;
}

export interface ReleasesPage {
  /** What latest.json names; null when there is none. */
  current: ReleasePointer | null;
  commits: ReleaseCommit[];
  nextCursor: string | null;
}

/** A refused write, with the API's error code (`main-moved`,
 * `latest-update-failed`). */
export class HostedRequestError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "HostedRequestError";
  }
}

function hostedUrl(orgSlug: string, virtualMcpId: string, path: string) {
  return `/api/${orgSlug}/hosted/${encodeURIComponent(virtualMcpId)}/${path}`;
}

async function readJson<T>(res: Response): Promise<T> {
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new HostedRequestError(
      json.error ?? `HTTP ${res.status}`,
      json.error ?? null,
    );
  }
  return json as T;
}

export function useReleases(
  orgSlug: string,
  virtualMcpId: string,
  options: { enabled?: boolean } = {},
) {
  return useInfiniteQuery({
    queryKey: KEYS.hostedReleases(orgSlug, virtualMcpId),
    enabled: options.enabled ?? true,
    queryFn: async ({ pageParam }) => {
      const query = pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : "";
      return readJson<ReleasesPage>(
        await fetch(hostedUrl(orgSlug, virtualMcpId, `releases${query}`), {
          cache: "no-store",
        }),
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** "Make current"'s answer: Publish's, plus whether the schema differed. */
export type ReapplyResult = HostedPublishResult & { schemaChanged?: boolean };

/**
 * Before "Make current": whether that version was made for another design
 * of the site (the dialog then adds how to go back). Read while the dialog
 * is open; the dialog never waits for it, and a failed read says nothing.
 */
export function useReapplyCheck(
  orgSlug: string,
  virtualMcpId: string,
  sha: string | null,
  latest: string | null,
) {
  return useQuery({
    queryKey: KEYS.hostedReapplyCheck(orgSlug, virtualMcpId, sha, latest),
    enabled: sha !== null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    queryFn: async () =>
      readJson<{ schemaChanged: boolean }>(
        await fetch(
          hostedUrl(
            orgSlug,
            virtualMcpId,
            `releases/${encodeURIComponent(sha ?? "")}/reapply`,
          ),
          { cache: "no-store" },
        ),
      ),
  });
}

/**
 * "Make current": a new version with the content of the version of `sha`
 * (the API commits it and runs Publish's release path). A content change
 * (content-sync.ts): the releases, the editor's blocks, the publish status
 * and the preview refresh as after a Publish, on a failure too.
 */
export function useReapply(orgSlug: string, virtualMcpId: string) {
  const content = useContentSyncTarget({
    orgSlug,
    virtualMcpId,
    branch: useOptionalChatTask()?.currentBranch ?? null,
  });
  return useMutation({
    mutationFn: (vars: { sha: string }) =>
      runContentChange(content, {
        kind: "reapply",
        reread: true,
        refreshOnError: true,
        write: async () =>
          readJson<ReapplyResult>(
            await fetch(
              hostedUrl(
                orgSlug,
                virtualMcpId,
                `releases/${encodeURIComponent(vars.sha)}/reapply`,
              ),
              { method: "POST" },
            ),
          ),
      }),
  });
}

/**
 * "Try again" after a reapply that saved its content but wasn't released:
 * Publish's own retry (main's head released).
 */
export function useRetryRelease(orgSlug: string, virtualMcpId: string) {
  const content = useContentSyncTarget({
    orgSlug,
    virtualMcpId,
    branch: useOptionalChatTask()?.currentBranch ?? null,
  });
  return useMutation({
    mutationFn: () =>
      runContentChange(content, {
        kind: "reapply",
        refreshOnError: true,
        write: () => retryRelease({ orgSlug, virtualMcpId }),
      }),
  });
}
