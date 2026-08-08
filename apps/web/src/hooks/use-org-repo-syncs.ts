/**
 * Per-org GitHub repo → volume syncs (`ORG_REPO_SYNC_*` tools).
 *
 * Managed from Settings → Synced repos; the Library only reads the list to
 * render the synced volumes as read-only folders and to mark them read-only
 * while browsing (the sync mirrors the repo — local edits would be deleted on
 * the next cycle).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StudioToolIO } from "@decocms/shared/tools/tool-io";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";

export type OrgRepoSyncConfig =
  StudioToolIO["ORG_REPO_SYNC_LIST"]["output"]["configs"][number];

export function useOrgRepoSyncs() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.orgRepoSyncs(org.id),
    staleTime: 60_000,
    queryFn: async () => (await studio.call("ORG_REPO_SYNC_LIST", {})).configs,
  });
}

/** Volume names owned by repo syncs — the Library browses them read-only. */
export function useOrgRepoSyncVolumes(): ReadonlySet<string> {
  const syncs = useOrgRepoSyncs();
  return new Set((syncs.data ?? []).map((c) => c.volume));
}

/** Create a sync config and run its first sync inline, so the volume isn't
 *  empty until the next cron tick. */
export function useCreateOrgRepoSync() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { connectionId: string; volume: string }) => {
      const { config } = await studio.call("ORG_REPO_SYNC_CREATE", input);
      return studio.call("ORG_REPO_SYNC_RUN", { id: config.id });
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: KEYS.orgRepoSyncs(org.id) }),
  });
}

export function useDeleteOrgRepoSync() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => studio.call("ORG_REPO_SYNC_DELETE", { id }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: KEYS.orgRepoSyncs(org.id) }),
  });
}
