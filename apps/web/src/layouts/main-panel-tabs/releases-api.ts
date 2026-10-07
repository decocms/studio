/**
 * The Releases screen's reads and writes (`/api/:org/hosted/:vmcp/*`): what
 * latest.json serves, main's history with the commits that have a release
 * on the CDN, "Make current" (rewrites latest.json only) and Resync.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";

export type ReleaseState = "live" | "rolled-back" | "pending";

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
  published: boolean;
}

export interface ReleasesPage {
  current: ReleasePointer | null;
  head: string;
  headSchemaHash: string | null;
  state: ReleaseState;
  /** Main's head has no revision on the CDN (a developer's push). */
  unpublishedCommits: boolean;
  /** latest.json's revision isn't in main's history. */
  revisionOffMain: boolean;
  /** No CMS-published commit in the last 250 of main. */
  noRecentRelease: boolean;
  commits: ReleaseCommit[];
  nextCursor: string | null;
}

/** A refused write, with the API's error code (`schema-mismatch`, `rolled-back`). */
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
  });
}

function useHostedWrite<TVars>(
  orgSlug: string,
  virtualMcpId: string,
  request: (vars: TVars) => Promise<Response>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: TVars) => readJson<unknown>(await request(vars)),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: KEYS.hostedReleases(orgSlug, virtualMcpId),
      }),
  });
}

/** "Make current": point latest.json at a published commit. */
export function useMakeCurrent(orgSlug: string, virtualMcpId: string) {
  return useHostedWrite(
    orgSlug,
    virtualMcpId,
    (vars: { sha: string; confirm: boolean }) =>
      fetch(hostedUrl(orgSlug, virtualMcpId, "releases/current"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(vars),
      }),
  );
}

/** Resync: release main's head again (confirm overrides a rollback). */
export function useResync(orgSlug: string, virtualMcpId: string) {
  return useHostedWrite(orgSlug, virtualMcpId, (vars: { confirm: boolean }) =>
    fetch(hostedUrl(orgSlug, virtualMcpId, "resync"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(vars),
    }),
  );
}
