import { useProjectContext, useVirtualMCP } from "@/sdk";
import { useQueryClient } from "@tanstack/react-query";
import {
  applyReleaseEdit,
  type ReleaseEdit,
} from "@decocms/shared/release-edits";
import type { Release, VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { runSerializedTask } from "@/lib/serial-task-queue";
import { callStudioTool } from "@/lib/studio-tools";

/**
 * Dot colors a named release can take, in assignment order. `success` (green) is
 * intentionally excluded — it's reserved for "Produção" (the published base) so
 * the live version always reads as green and never collides with a draft's dot.
 */
const RELEASE_COLORS = ["orange", "violet", "blue", "pink", "amber", "teal"];

/** Round-robin the palette by current count so new releases look distinct. */
export function nextReleaseColor(count: number): string {
  return RELEASE_COLORS[count % RELEASE_COLORS.length]!;
}

/**
 * Next auto name for an unnamed draft: one above the highest existing
 * "`{base}` N" (e.g. "Rascunho 3" → "Rascunho 4"), starting at "`{base}` 1".
 * Renamed releases don't count. Shared so the branch picker and the "start a
 * new draft" CTAs number drafts identically.
 */
export function nextDraftName(releases: Release[], base: string): string {
  const prefix = `${base} `;
  const max = releases.reduce((m, r) => {
    if (!r.name.startsWith(prefix)) return m;
    const n = Number(r.name.slice(prefix.length));
    return Number.isInteger(n) && n > m ? n : m;
  }, 0);
  return `${base} ${max + 1}`;
}

const DOT_CLASS: Record<string, string> = {
  orange: "bg-orange-500",
  violet: "bg-violet-500",
  blue: "bg-blue-500",
  pink: "bg-pink-500",
  amber: "bg-amber-500",
  teal: "bg-teal-500",
};

const ICON_CLASS: Record<string, string> = {
  orange: "text-orange-500",
  violet: "text-violet-500",
  blue: "text-blue-500",
  pink: "text-pink-500",
  amber: "text-amber-500",
  teal: "text-teal-500",
};

/** Text color for a coding draft's icon, which replaces its dot. */
export function releaseIconClass(color: string | undefined): string {
  return (color && ICON_CLASS[color]) || "text-muted-foreground";
}

/** Tailwind class for a stored color token; falls back to a neutral dot. */
export function releaseDotClass(color: string | undefined): string {
  return (color && DOT_CLASS[color]) || "bg-muted-foreground";
}

type ItemData = { item: VirtualMCPEntity | null };

/** Curated branch-backed release list at `metadata.releases`; discard drops only the entry, leaving the remote branch. */
export function useReleases(virtualMcpId: string) {
  const vm = useVirtualMCP(virtualMcpId);
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const releases: Release[] = vm?.metadata?.releases ?? [];

  const isItemQuery = (queryKey: readonly unknown[]) =>
    queryKey[1] === org.id &&
    queryKey[3] === "collection" &&
    queryKey[4] === "VIRTUAL_MCP" &&
    queryKey[5] === virtualMcpId;

  /** Freshest committed list, so a queued edit sees the previous one's result —
   *  not a stale render snapshot. Falls back to the render value pre-hydration. */
  const readCacheReleases = (): Release[] => {
    for (const [, data] of queryClient.getQueriesData<ItemData>({
      predicate: (q) => isItemQuery(q.queryKey),
    })) {
      if (data?.item) return data.item.metadata?.releases ?? [];
    }
    return releases;
  };

  const setCacheReleases = (next: Release[]) =>
    queryClient.setQueriesData<ItemData>(
      { predicate: (q) => isItemQuery(q.queryKey) },
      (old) =>
        old?.item
          ? {
              item: {
                ...old.item,
                metadata: { ...old.item.metadata, releases: next },
              },
            }
          : old,
    );

  /**
   * The server applies `edit` to the stored list and answers with it, so an
   * old copy here can't overwrite other tabs' edits. The cache takes the edit
   * at once and then the server's list. Edits stay serialized per project so
   * each optimistic step builds on the previous one.
   *
   * Silent: these writes follow a user action (Publish, a rename) that has
   * its own one toast, or happen in the background (auto-naming a draft).
   * Callers report a failure themselves when the user can act on it.
   */
  const write = (edit: ReleaseEdit) =>
    runSerializedTask(`vm-releases:${virtualMcpId}`, async () => {
      const current = readCacheReleases();
      const next = applyReleaseEdit(current, edit);
      if (next === current) return;
      setCacheReleases(next);
      try {
        const stored = await callStudioTool(
          org.slug,
          "VIRTUAL_MCP_RELEASE_EDIT",
          { id: virtualMcpId, edit },
        );
        setCacheReleases(stored.releases);
      } catch (err) {
        queryClient.invalidateQueries({
          predicate: (q) => isItemQuery(q.queryKey),
        });
        throw err;
      }
    });

  const createRelease = (release: Release) => write({ op: "add", release });

  const createPullRequestRelease = (release: Release) =>
    write({ op: "add-pull-request", release });

  const renameRelease = (branch: string, name: string) =>
    write({ op: "rename", branch, name });

  const deleteRelease = (branch: string) => write({ op: "remove", branch });

  const markSandbox = (branch: string) => write({ op: "mark-sandbox", branch });

  return {
    releases,
    createRelease,
    createPullRequestRelease,
    renameRelease,
    deleteRelease,
    markSandbox,
  };
}
