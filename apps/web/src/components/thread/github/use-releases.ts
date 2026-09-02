import { useProjectContext, useVirtualMCP, useVirtualMCPActions } from "@/sdk";
import { useQueryClient } from "@tanstack/react-query";
import { callStudioTool } from "@/lib/studio-tools";
import { getActiveGithubRepo } from "@/lib/github-repo";
import type { Release, VirtualMCPEntity } from "@decocms/shared/sdk/types";

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

const DOT_CLASS: Record<string, string> = {
  orange: "bg-orange-500",
  violet: "bg-violet-500",
  blue: "bg-blue-500",
  pink: "bg-pink-500",
  amber: "bg-amber-500",
  teal: "bg-teal-500",
};

/** Tailwind class for a stored color token; falls back to a neutral dot. */
export function releaseDotClass(color: string | undefined): string {
  return (color && DOT_CLASS[color]) || "bg-muted-foreground";
}

type ItemData = { item: VirtualMCPEntity | null };

/**
 * The curated, branch-backed release list stored at `metadata.releases` — NOT
 * the git branch list. Writers patch the cached VIRTUAL_MCP item first so the
 * switcher updates instantly, then persist (a failure reverts). Delete also
 * removes the git branch so a discarded draft leaves nothing behind.
 */
export function useReleases(virtualMcpId: string) {
  const vm = useVirtualMCP(virtualMcpId);
  const actions = useVirtualMCPActions();
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const releases: Release[] = vm?.metadata?.releases ?? [];
  const repo = getActiveGithubRepo(vm);

  const isItemQuery = (queryKey: readonly unknown[]) =>
    queryKey[1] === org.id &&
    queryKey[3] === "collection" &&
    queryKey[4] === "VIRTUAL_MCP" &&
    queryKey[5] === virtualMcpId;

  const write = (next: Release[]) => {
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
    return actions.update
      .mutateAsync({
        id: virtualMcpId,
        data: {
          metadata: { releases: next } as unknown as NonNullable<
            VirtualMCPEntity["metadata"]
          >,
        },
      })
      .catch((err) => {
        queryClient.invalidateQueries({
          predicate: (q) => isItemQuery(q.queryKey),
        });
        throw err;
      });
  };

  const createRelease = (release: Release) => write([...releases, release]);

  const renameRelease = (branch: string, name: string) =>
    write(releases.map((r) => (r.branch === branch ? { ...r, name } : r)));

  const deleteRelease = async (branch: string) => {
    await write(releases.filter((r) => r.branch !== branch));
    if (repo?.connectionId) {
      await callStudioTool(org.slug, "GITHUB_DELETE_BRANCH", {
        connectionId: repo.connectionId,
        owner: repo.owner,
        repo: repo.name,
        branch,
      });
    }
  };

  return { releases, createRelease, renameRelease, deleteRelease };
}
