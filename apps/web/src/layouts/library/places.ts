import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";
import { PROJECTS_FOLDER } from "@decocms/shared/organization/project-folder";
import { useOrgFsPublicSets } from "@/hooks/use-org-fs";
import { useOrgRepoSyncs } from "@/hooks/use-org-repo-syncs";
import { useT } from "@/i18n/use-t.ts";

export interface LibraryPlace {
  key: string;
  label: string;
  path: string;
}

/** The places of the drive, each a separate volume or folder underneath.
 *  Only the org's drive has them: a project's files are one place. */
export function useLibraryPlaces(root: string): LibraryPlace[] {
  const t = useT();
  const syncs = useOrgRepoSyncs();
  const publicSets = useOrgFsPublicSets();
  if (root !== HOME_MOUNT_PATH) return [];
  return [
    { key: "all", label: t("library.library.all"), path: root },
    {
      key: PROJECTS_FOLDER,
      label: t("library.library.placeProjects"),
      path: `${HOME_MOUNT_PATH}/${PROJECTS_FOLDER}`,
    },
    {
      key: "uploads",
      label: t("library.library.placeUploads"),
      path: "uploads",
    },
    {
      key: "outputs",
      label: t("library.library.placeOutputs"),
      path: "outputs",
    },
    ...((publicSets.data?.length ?? 0) > 0
      ? [
          {
            key: "public",
            label: t("library.library.placeSkills"),
            path: "public",
          },
        ]
      : []),
    ...(syncs.data ?? []).map((sync) => ({
      key: sync.volume,
      label: sync.volume,
      path: sync.volume,
    })),
  ];
}
