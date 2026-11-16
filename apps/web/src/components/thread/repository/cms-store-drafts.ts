/**
 * The hosted CMS's own draft list (`GET /api/cms/:site/drafts`, the
 * `drafts` table) next to the version switcher's curated `metadata.releases`.
 *
 * The switcher lists only releases, which Studio writes when someone makes a
 * draft in Studio. A draft made anywhere else (`deco push --draft`, a site
 * token, an agent) is a row in the CMS's table and nothing in
 * `metadata.releases`, so it never showed. The table is the source of truth
 * for which drafts exist; the releases add names and colors on top. So the
 * switcher shows the releases, then every draft the table holds that no
 * release names and Studio didn't make.
 *
 * Studio-made drafts (`via: "studio"`) stay out: discarding a release drops
 * only its entry and leaves the CMS draft behind, so listing them would bring
 * back every draft someone discarded.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Release } from "@decocms/shared/sdk/types";
import { cmsRequest, cmsSiteOf } from "@/cms/cms-api";
import { KEYS } from "@/lib/query-keys";
import { useVirtualMCP } from "@/sdk";

/** A row of `GET /api/cms/:site/drafts` (contract §4.4, the `drafts` table). */
export interface StoreDraft {
  name: string;
  /** The Studio user id that created it. */
  createdBy: string;
  /** How it was created: `studio`, `cli`, `token` or `studio-agent`. */
  via: string;
  createdAt: string;
}

/**
 * The CMS's drafts the switcher should add to the releases: not made in
 * Studio, and named by no release (a release's branch is its draft's name).
 * Newest first, as the table answers them.
 */
export function unlistedStoreDrafts(
  releases: readonly Release[],
  drafts: readonly StoreDraft[] | undefined,
): StoreDraft[] {
  if (!drafts?.length) return [];
  const named = new Set(releases.map((r) => r.branch));
  const seen = new Set<string>();
  return drafts
    .filter((d) => {
      if (d.via === "studio" || named.has(d.name) || seen.has(d.name)) {
        return false;
      }
      seen.add(d.name);
      return true;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The label after a store draft's name: how it was made. */
export function storeDraftVia(via: string): string {
  switch (via) {
    case "cli":
      return "CLI";
    case "token":
      return "API";
    case "studio-agent":
      return "Studio";
    default:
      return via;
  }
}

/**
 * The project's site drafts, from the hosted CMS. Off for a project with no
 * site (v7, or a v8 project not on the hosted CMS) — the switcher then shows
 * releases only, as before.
 */
export function useStoreDrafts(virtualMcpId: string, enabled: boolean) {
  const site = cmsSiteOf(useVirtualMCP(virtualMcpId)?.metadata);
  const query = useQuery({
    queryKey: KEYS.hostedDrafts(site ?? ""),
    enabled: enabled && !!site,
    staleTime: 30_000,
    // A failed read leaves the releases as they are; nothing to report.
    retry: false,
    queryFn: async () => {
      const { drafts } = await cmsRequest<{ drafts?: StoreDraft[] }>(
        site!,
        "drafts",
      );
      return drafts ?? [];
    },
  });
  return query;
}

/** Discards one of the project's site drafts, then reads the list again. */
export function useDiscardStoreDraft(virtualMcpId: string) {
  const site = cmsSiteOf(useVirtualMCP(virtualMcpId)?.metadata);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      if (!site) throw new Error("This project has no hosted CMS site");
      await discardStoreDraft(site, name);
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: KEYS.hostedDrafts(site ?? ""),
      }),
  });
}

/**
 * Whether `branch` is a CMS draft made outside Studio (`deco push --draft`, a
 * site token, an agent): it already has a name, so Studio must not give it a
 * "Draft N" release. `undefined` while the list isn't read yet, so a caller
 * waits instead of guessing.
 */
export function isForeignStoreDraft(
  branch: string,
  drafts: readonly StoreDraft[] | undefined,
): boolean | undefined {
  if (drafts === undefined) return undefined;
  return drafts.some((d) => d.name === branch && d.via !== "studio");
}

/**
 * Discards a CMS draft (`DELETE /api/cms/:site/drafts/:name`): its row and its
 * unpublished changes, as `deco drafts discard` does. Published content is
 * untouched.
 */
async function discardStoreDraft(site: string, name: string): Promise<void> {
  await cmsRequest<{ discarded?: boolean }>(
    site,
    `drafts/${encodeURIComponent(name)}`,
    {
      method: "DELETE",
    },
  );
}
