/**
 * The Releases screen's reads and writes (`/api/:org/hosted/:vmcp/*`): the
 * timeline of main's commits with the ones that have a companion release,
 * what latest.json names, what the site itself reports serving, and
 * Republish (a new release with an earlier one's content).
 */

import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import { runContentChange } from "@/components/sections-editor/content-sync";
import { useContentSyncTarget } from "@/components/sections-editor/use-content-sync";
import { KEYS } from "@/lib/query-keys";
import {
  type HostedPublishResult,
  publishMainHead,
} from "@/components/thread/repository/hosted-publish-api";
import { GOING_LIVE_POLL_MS, waitingForSite } from "./releases-status";

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
  /** Has a companion release on the CDN: it can be republished. */
  hasRelease: boolean;
  /** This release republished the release of that commit. */
  republishOf: { sha: string } | null;
}

/**
 * What the site serves. `site`: what its telemetry reported in the last
 * minutes (`revision` null when it matches no release here). `none`: no
 * report; the screen falls back to `current`, and says so.
 */
export type ReleaseServing =
  | { source: "site"; revision: string | null; lastSeen: string }
  | { source: "none" };

export interface ReleasesPage {
  /** What latest.json names; null when there is none. */
  current: ReleasePointer | null;
  /** On the first page only. */
  serving: ReleaseServing | null;
  commits: ReleaseCommit[];
  nextCursor: string | null;
}

/** A refused write, with the API's error code (`schema-mismatch`,
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

export function useReleases(orgSlug: string, virtualMcpId: string) {
  return useInfiniteQuery({
    queryKey: KEYS.hostedReleases(orgSlug, virtualMcpId),
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
    // A release just published is "Going live…" until the site reports it:
    // ask again every 15 s while it waits (ten minutes at most).
    refetchInterval: (query: {
      state: { data?: { pages: ReleasesPage[] } };
    }) => {
      const first = query.state.data?.pages[0];
      return first && waitingForSite(first) ? GOING_LIVE_POLL_MS : false;
    },
  });
}

/**
 * Republish: a new release with the content of the release of `sha` (the
 * API commits it and runs Publish's release path). A content change
 * (content-sync.ts): the releases, the editor's blocks, the publish status
 * and the preview refresh as after a Publish, on a failure too.
 */
export function useRepublish(orgSlug: string, virtualMcpId: string) {
  const content = useContentSyncTarget({
    orgSlug,
    virtualMcpId,
    branch: useOptionalChatTask()?.currentBranch ?? null,
  });
  return useMutation({
    mutationFn: (vars: { sha: string; confirm: boolean }) =>
      runContentChange(content, {
        kind: "republish",
        reread: true,
        refreshOnError: true,
        write: async () =>
          readJson<HostedPublishResult>(
            await fetch(
              hostedUrl(
                orgSlug,
                virtualMcpId,
                `releases/${encodeURIComponent(vars.sha)}/republish`,
              ),
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ confirm: vars.confirm }),
              },
            ),
          ),
      }),
  });
}

/**
 * "Try again" after a Republish that saved its content but didn't put it
 * live: Publish's own retry (main's head made current).
 */
export function usePutMainLive(orgSlug: string, virtualMcpId: string) {
  const content = useContentSyncTarget({
    orgSlug,
    virtualMcpId,
    branch: useOptionalChatTask()?.currentBranch ?? null,
  });
  return useMutation({
    mutationFn: () =>
      runContentChange(content, {
        kind: "republish",
        refreshOnError: true,
        write: () => publishMainHead({ orgSlug, virtualMcpId }),
      }),
  });
}
