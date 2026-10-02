/**
 * Gives a project's folder its fixed subfolders and `memory.md` the first time
 * its files are opened in a session. Projects created before the scaffold
 * existed only get one this way. Non-blocking: the Library paints at once and
 * refreshes when the scaffold lands.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";
import { projectFolderDir } from "@decocms/shared/organization/project-folder";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { KEYS } from "@/lib/query-keys";
import { callStudioTool } from "@/lib/studio-tools";
import { useProjectContext } from "@/sdk";

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
      await queryClient.invalidateQueries({
        queryKey: KEYS.orgFsVolume(org.id, HOME_MOUNT_PATH),
      });
      return result;
    },
    enabled: !!project,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}
