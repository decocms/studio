/**
 * Why a member may not write a path in the org filesystem, or null when they
 * may. For writers outside the `/api/:org/fs` routes (the object-storage tools
 * and their upload grants), which apply the same rules as those routes.
 */

import type { StudioContext } from "@/core/studio-context";
import { isValidVolume, normalizeFsPath } from "./org-fs-path";
import { canWritePersonal } from "./personal-home";
import { isPublicVolume } from "./public-sets";

export async function orgFsWriteDenial(
  storage: Pick<StudioContext["storage"], "orgRepoSyncs">,
  target: {
    organizationId: string;
    volume: string;
    path: string;
    userId: string;
  },
): Promise<string | null> {
  const { organizationId, volume, path, userId } = target;
  if (!isValidVolume(volume)) return `Invalid volume name: "${volume}"`;
  if (normalizeFsPath(path) === "") {
    return "A path inside the volume is required";
  }
  if (isPublicVolume(volume)) return "Public volumes are read-only";
  if (!canWritePersonal(volume, path, userId)) {
    return "This folder belongs to another member";
  }
  if (await storage.orgRepoSyncs.isSyncVolume(organizationId, volume)) {
    return "Synced volumes are read-only — managed by repo sync";
  }
  return null;
}
