/**
 * The Releases screen's reads and writes, on the hosted CMS
 * (`/api/cms/:site/releases`, contract §4.10 and §4.11): the site's
 * revisions, newest first, 50 a page, each with its meta and whether it is
 * the one latest.json names (`current`) or any other (`listed`), or a row
 * whose meta.json couldn't be read (`unreadable`, its id only); and "Make
 * current", a rollback: a new revision with another one's content.
 */

import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import {
  cmsJson,
  cmsSiteOf,
  cmsUrl,
} from "@/components/sections-editor/cms-api";
import { runContentChange } from "@/components/sections-editor/content-sync";
import { useContentSyncTarget } from "@/components/sections-editor/use-content-sync";
import { KEYS } from "@/lib/query-keys";
import { useVirtualMCP } from "@/sdk";

/** A revision's `meta.json` (contract §2.3). */
export interface RevisionMeta {
  previous: string | null;
  draft?: string;
  reapplyOf?: string;
  /** The Studio user id that published it. */
  author: string;
  via: string;
  message: string;
  publishedAt: string;
}

/** `current`: the one latest.json names; `listed`: any other. */
export type ReleaseStatus = "current" | "listed";

export interface ReadableRelease {
  id: string;
  status: ReleaseStatus;
  meta: RevisionMeta;
}

/** A revision whose meta.json couldn't be read: its id, no meta. */
export interface UnreadableRelease {
  id: string;
  status: "unreadable";
}

export type ReleaseRevision = ReadableRelease | UnreadableRelease;

export interface ReleasesPage {
  /** The revision latest.json names; null before the first publish. */
  live: string | null;
  revisions: ReleaseRevision[];
  nextCursor: string | null;
}

/** "Make current"'s answer (contract §4.11). */
export type RollbackResult =
  | { result: "published"; revision: string; previous: string | null }
  | { result: "up-to-date"; revision: string | null };

/** The project's site, which the hosted CMS keys everything on. */
function useProjectSite(virtualMcpId: string): string | null {
  return cmsSiteOf(useVirtualMCP(virtualMcpId)?.metadata);
}

export function useReleases(orgSlug: string, virtualMcpId: string) {
  const site = useProjectSite(virtualMcpId);
  return useInfiniteQuery({
    queryKey: KEYS.hostedReleases(orgSlug, virtualMcpId),
    queryFn: async ({ pageParam }) => {
      if (!site) throw new Error("this project names no site");
      const query = pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : "";
      return cmsJson<ReleasesPage>(
        await fetch(cmsUrl(site, `releases${query}`), {
          cache: "no-store",
        }),
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

/**
 * "Make current": a new revision with the content of revision `id` (a
 * rollback, or a roll-forward). A content change (content-sync.ts): the
 * releases, the editor's blocks, the publish status and the preview refresh
 * as after a Publish, on a failure too.
 */
export function useReapply(orgSlug: string, virtualMcpId: string) {
  const site = useProjectSite(virtualMcpId);
  const content = useContentSyncTarget({
    orgSlug,
    virtualMcpId,
    branch: useOptionalChatTask()?.currentBranch ?? null,
  });
  return useMutation({
    mutationFn: (vars: { id: string }) =>
      runContentChange(content, {
        kind: "reapply",
        reread: true,
        refreshOnError: true,
        // The editor's preview shows the revision made current (or, already
        // shown, the live one) until the next change.
        shownRevision: (made) => made.revision,
        write: async () => {
          if (!site) throw new Error("this project names no site");
          return cmsJson<RollbackResult>(
            await fetch(
              cmsUrl(site, `releases/${encodeURIComponent(vars.id)}/rollback`),
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}",
              },
            ),
          );
        },
      }),
  });
}
