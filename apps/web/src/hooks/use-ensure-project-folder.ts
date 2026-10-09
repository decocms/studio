/**
 * Gives a project's folder its fixed subfolders and `memory.md` the first time
 * its files are opened in a session. Projects created before the scaffold
 * existed only get one this way; the server does it once per project, so a
 * folder a person removed later stays removed. Non-blocking: the Library
 * paints at once and refreshes when the scaffold lands.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";
import {
  pinnedProjectFolderName,
  projectFolderDir,
} from "@decocms/shared/organization/project-folder";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { invalidateOrgFsWrite } from "@/hooks/use-org-fs";
import { KEYS } from "@/lib/query-keys";
import { callStudioTool } from "@/lib/studio-tools";
import { useProjectContext } from "@/sdk";
import { invalidateCollectionQueries } from "@/sdk/hooks/use-collections";

export function useEnsureProjectFolder(project: VirtualMCPEntity | null): void {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  useQuery({
    queryKey: KEYS.projectFolderEnsure(
      org.id,
      project?.id ?? "",
      project ? projectFolderDir(project) : "",
    ),
    queryFn: async () => {
      const result = await callStudioTool(org.slug, "PROJECT_FOLDER_ENSURE", {
        id: project?.id ?? "",
      });
      if (result.created) {
        invalidateOrgFsWrite(queryClient, org.id, HOME_MOUNT_PATH);
        /** The folder name is now pinned on the project; re-read it. */
        invalidateCollectionQueries(queryClient, org.id, "VIRTUAL_MCP");
      }
      return result;
    },
    enabled: !!project && !pinnedProjectFolderName(project),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}
