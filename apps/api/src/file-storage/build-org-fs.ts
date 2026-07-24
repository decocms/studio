/**
 * Build an `OrgFs` bound to an arbitrary org scope.
 *
 * `ctx.orgFs` is bound to the REQUEST's org, which is the right default for
 * every normal code path. A few server-side flows need a different scope than
 * the caller's: the public skill-set volumes (a system org shared by everyone)
 * and the deployment-admin agent copy (reads the source org, writes the
 * target). Those go through here so the "S3 when configured, dev storage
 * otherwise" fallback lives in exactly one place — mirroring the per-request
 * rebind in `rebindOrgScope`.
 */

import { createBoundObjectStorage } from "../object-storage/bound-object-storage";
import { DevObjectStorage } from "../object-storage/dev-object-storage";
import { getObjectStorageS3Service } from "../object-storage/factory";
import type { StudioContext } from "../core/studio-context";
import { OrgFs } from "./org-fs";

export function buildOrgFs(ctx: StudioContext, organizationId: string): OrgFs {
  const s3Service = getObjectStorageS3Service();
  const storage = s3Service
    ? createBoundObjectStorage(s3Service, organizationId)
    : new DevObjectStorage(organizationId, ctx.baseUrl);
  return new OrgFs(storage, ctx.storage.orgFsEntries, organizationId);
}
