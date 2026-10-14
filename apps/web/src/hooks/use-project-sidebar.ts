/**
 * The project sidebar's data: the org's folders and the caller's own pins and
 * hides, in one `SIDEBAR_GET`, plus the two writes.
 *
 * Both writes send a WHOLE document. Each edit is an updater applied to the
 * cache in `onMutate`, and `mutationFn` sends what the cache then holds — so
 * two quick edits chain off each other instead of the second rebuilding from
 * a stale render and dropping the first (as `use-user-model-preferences`).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import {
  EMPTY_SIDEBAR_PREFERENCES,
  type ProjectFolder,
  type Sidebar,
  type SidebarPreferences,
} from "@decocms/shared/project-sidebar";
import { KEYS } from "@/lib/query-keys";
import { callStudioTool, useStudioTools } from "@/lib/studio-tools";
import { useProjectContext } from "@/sdk";
import { projectFoldersWatchView } from "./watch-sse-pool";

const EMPTY_SIDEBAR: Sidebar = {
  folders: [],
  preferences: EMPTY_SIDEBAR_PREFERENCES,
  joinedAt: null,
};

export function useProjectSidebar(): Sidebar {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const queryKey = KEYS.projectSidebar(org.id);

  // Folders are org-wide: another member's edit re-reads them here.
  useSyncExternalStore(
    (onStoreChange) =>
      projectFoldersWatchView.subscribe(
        org.slug,
        () => {
          queryClient.invalidateQueries({ queryKey });
          onStoreChange();
        },
        () => queryClient.invalidateQueries({ queryKey }),
      ),
    () => 0,
    () => 0,
  );

  const { data } = useQuery({
    queryKey,
    queryFn: async () =>
      (await callStudioTool(org.slug, "SIDEBAR_GET", {})) as Sidebar,
    staleTime: 60_000,
  });
  return data ?? EMPTY_SIDEBAR;
}

/** Write through the cache, then send the cache's document. */
function useSidebarWrite<T>(
  pick: (sidebar: Sidebar) => T,
  put: (sidebar: Sidebar, value: T) => Sidebar,
  send: (value: T) => Promise<T>,
) {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const key = KEYS.projectSidebar(org.id);
  const read = () => queryClient.getQueryData<Sidebar>(key) ?? EMPTY_SIDEBAR;

  return useMutation({
    mutationKey: [...key, "write"],
    mutationFn: async (_update: (value: T) => T) => send(pick(read())),
    onMutate: (update) => {
      const prev = queryClient.getQueryData<Sidebar>(key);
      const base = prev ?? EMPTY_SIDEBAR;
      queryClient.setQueryData<Sidebar>(key, put(base, update(pick(base))));
      return { prev };
    },
    onError: (_error, _update, context) => {
      queryClient.setQueryData(key, context?.prev ?? EMPTY_SIDEBAR);
    },
    onSettled: () => {
      // Only the last write refetches, so a sibling's optimistic value survives.
      if (queryClient.isMutating({ mutationKey: [...key, "write"] }) === 1) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

/** The caller's own pins and hides. */
export function useUpdateSidebarPreferences() {
  const studio = useStudioTools();
  return useSidebarWrite<SidebarPreferences>(
    (sidebar) => sidebar.preferences,
    (sidebar, preferences) => ({ ...sidebar, preferences }),
    async (preferences) =>
      (await studio.call(
        "SIDEBAR_PREFERENCES_SET",
        preferences,
      )) as SidebarPreferences,
  );
}

/** The org's folders, for everyone. Needs `agents:manage`. */
export function useUpdateProjectFolders() {
  const studio = useStudioTools();
  return useSidebarWrite<ProjectFolder[]>(
    (sidebar) => sidebar.folders,
    (sidebar, folders) => ({ ...sidebar, folders }),
    async (folders) =>
      (
        (await studio.call("PROJECT_FOLDERS_SET", { folders })) as {
          folders: ProjectFolder[];
        }
      ).folders,
  );
}
