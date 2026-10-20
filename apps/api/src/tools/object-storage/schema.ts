import { OBJECT_STORAGE_BINDING } from "@decocms/bindings/object-storage";
import type { StudioContext } from "../../core/studio-context";
import type { BoundObjectStorage } from "../../object-storage/bound-object-storage";
import { ForbiddenError } from "../../core/access-control";
import { getUserId } from "../../core/studio-context";
import type { OrgFs } from "../../file-storage/org-fs";
import { notifyOrgFsChangeFromServer } from "../../file-storage/org-fs-notify";
import { fsObjectKey, normalizeFsPath } from "../../file-storage/org-fs-path";
import { orgFsWriteDenial } from "../../file-storage/org-fs-write-guard";
import { canReadPersonal } from "../../file-storage/personal-home";

export function requireObjectStorage(ctx: StudioContext): BoundObjectStorage {
  if (!ctx.objectStorage) {
    throw new Error(
      "Object storage is not configured. Ensure S3 credentials are set.",
    );
  }
  return ctx.objectStorage;
}

const MIN_EXPIRES_IN = 60;
// AWS SigV4 rejects a presigned URL past this lifetime.
const MAX_EXPIRES_IN = 604800;

/** Clamp a caller-supplied expiresIn to a sane range, falling back when absent/invalid. */
export function clampExpiresIn(
  value: number | undefined,
  fallback: number,
): number {
  const requested =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(Math.max(requested, MIN_EXPIRES_IN), MAX_EXPIRES_IN);
}

/**
 * A Library file addressed by an object-storage key (`_fs/<volume>/<path>`),
 * checked against the rules the `/api/:org/fs` routes apply. Writes to these
 * keys go through `OrgFs`, which keeps the `org_fs_entry` index the Library
 * lists from in step with the bytes.
 */
export async function requireOrgFsWrite(
  ctx: StudioContext,
  target: { volume: string; path: string },
): Promise<{
  orgFs: OrgFs;
  organizationId: string;
  userId: string;
  volume: string;
  path: string;
}> {
  const organizationId = ctx.organization?.id;
  const userId = getUserId(ctx);
  if (!organizationId || !userId) {
    throw new Error(
      "Library files need a signed-in member of the organization",
    );
  }
  if (!ctx.orgFs) {
    throw new Error(
      "Object storage is not configured. Ensure S3 credentials are set.",
    );
  }
  const path = normalizeFsPath(target.path);
  const denial = await orgFsWriteDenial(ctx.storage, {
    organizationId,
    volume: target.volume,
    path,
    userId,
  });
  if (denial) throw new ForbiddenError(denial);
  return {
    orgFs: ctx.orgFs,
    organizationId,
    userId,
    volume: target.volume,
    path,
  };
}

/**
 * Guards a read against a Library file (`_fs/<volume>/<path>` key): the
 * object-storage tools read any key in the bucket directly, which would
 * otherwise let a member fetch another member's `home/users/<id>/` files —
 * the one carve-out the `/api/:org/fs` routes enforce on top of "every
 * member reads every volume" (see org-fs.ts's ACL note).
 */
export function requireOrgFsRead(
  ctx: StudioContext,
  target: { volume: string; path: string },
): void {
  const userId = getUserId(ctx);
  if (!userId) {
    throw new Error(
      "Library files need a signed-in member of the organization",
    );
  }
  const path = normalizeFsPath(target.path);
  if (!canReadPersonal(target.volume, path, userId)) {
    throw new ForbiddenError("This file belongs to another member");
  }
}

/** Deletes a Library file or folder, and stray bytes a raw write left unindexed. */
export async function deleteOrgFsKey(
  ctx: StudioContext,
  target: { volume: string; path: string },
): Promise<void> {
  const { orgFs, organizationId, userId, volume, path } =
    await requireOrgFsWrite(ctx, target);
  if (await orgFs.stat(volume, path)) {
    await orgFs.delete(volume, path, { actor: userId });
  } else {
    await requireObjectStorage(ctx).delete(fsObjectKey(volume, path));
  }
  await notifyOrgFsChangeFromServer(organizationId, volume);
}

// Re-export schemas from the canonical OBJECT_STORAGE_BINDING definition
// so tool validation stays in sync with the advertised binding contract.
function getBinding<N extends (typeof OBJECT_STORAGE_BINDING)[number]["name"]>(
  name: N,
) {
  return OBJECT_STORAGE_BINDING.find((b) => b.name === name) as Extract<
    (typeof OBJECT_STORAGE_BINDING)[number],
    { name: N }
  >;
}

const listObjects = getBinding("LIST_OBJECTS");
export const ListObjectsInputSchema = listObjects.inputSchema;
export const ListObjectsOutputSchema = listObjects.outputSchema;

const getObjectMetadata = getBinding("GET_OBJECT_METADATA");
export const GetObjectMetadataInputSchema = getObjectMetadata.inputSchema;
export const GetObjectMetadataOutputSchema = getObjectMetadata.outputSchema;

const getPresignedUrl = getBinding("GET_PRESIGNED_URL");
export const GetPresignedUrlInputSchema = getPresignedUrl.inputSchema;
export const GetPresignedUrlOutputSchema = getPresignedUrl.outputSchema;

const putPresignedUrl = getBinding("PUT_PRESIGNED_URL");
export const PutPresignedUrlInputSchema = putPresignedUrl.inputSchema;
export const PutPresignedUrlOutputSchema = putPresignedUrl.outputSchema;

const deleteObject = getBinding("DELETE_OBJECT");
export const DeleteObjectInputSchema = deleteObject.inputSchema;
export const DeleteObjectOutputSchema = deleteObject.outputSchema;

const deleteObjects = getBinding("DELETE_OBJECTS");
export const DeleteObjectsInputSchema = deleteObjects.inputSchema;
export const DeleteObjectsOutputSchema = deleteObjects.outputSchema;
