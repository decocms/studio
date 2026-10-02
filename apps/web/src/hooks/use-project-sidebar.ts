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
  field: string,
  pick: (sidebar: Sidebar) => T,
  put: (sidebar: Sidebar, value: T) => Sidebar,
  send: (value: T) => Promise<T>,
) {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const key = KEYS.projectSidebar(org.id);
  const mutationKey = [...key, "write", field];
  const read = () => queryClient.getQueryData<Sidebar>(key) ?? EMPTY_SIDEBAR;

  return useMutation({
    mutationKey,
    mutationFn: async (_update: (value: T) => T) => send(pick(read())),
    onMutate: (update) => {
      const base = read();
      const prevValue = pick(base);
      queryClient.setQueryData<Sidebar>(key, put(base, update(prevValue)));
      return { prevValue };
    },
    onError: (_error, _update, context) => {
      // This field's last write reverts its own slice onto the current cache.
      if (context && queryClient.isMutating({ mutationKey }) === 1) {
        queryClient.setQueryData<Sidebar>(key, (sidebar) =>
          put(sidebar ?? EMPTY_SIDEBAR, context.prevValue),
        );
      }
    },
    onSettled: () => {
      // Only the last write of either field refetches, so a sibling's optimistic value survives.
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
    "preferences",
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
    "folders",
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
