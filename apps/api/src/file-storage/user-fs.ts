/**
 * Per-user filesystems.
 *
 * Every user owns one org-fs volume, named by their user id, inside a single
 * system organization seeded by migration 211. No members ever join that org,
 * so `resolveOrgFromPath` cannot reach it and no `/api/:org` route exposes it:
 * the only door is the instance-level `/api/_users` surface.
 *
 * Why a scope of its own rather than a folder in each org's filesystem:
 * `user.image` is global to the person, but every org-fs URL is `/api/:org/…`
 * and gated on membership, so a teammate in another org would 403 on the
 * avatar. Anything owned by a user rather than a tenant has that same shape,
 * which is why this is a filesystem and not an avatars table.
 *
 * One volume per user — rather than one per user per purpose — is what makes
 * the org-fs per-volume quota a per-user quota for free. The cost is that a
 * user cannot hold two independent volumes; that would want a real org row per
 * user, not a second convention here.
 */

import { createHash } from "node:crypto";
import { createBoundObjectStorage } from "../object-storage/bound-object-storage";
import { DevObjectStorage } from "../object-storage/dev-object-storage";
import { getObjectStorageS3Service } from "../object-storage/factory";
import type { StudioContext } from "../core/studio-context";
import { OrgFs, OrgFsNotFoundError, type OrgFsLimits } from "./org-fs";
import { isValidVolume } from "./org-fs-path";

/** System organization owning every user volume (migration 211). */
const USER_FS_ORG_ID = "org_user_fs";

/** Instance-level mount for the user filesystem surface. */
export const USER_FS_API_PREFIX = "/api/_users";

/** The one published directory: its whole subtree is world-readable. */
export const AVATAR_DIR = "avatars";

/**
 * Far below the org-fs defaults (500 MB/file, 10 GB/volume): a personal
 * filesystem is not a place to park a dataset, and the quota is per user.
 */
const USER_FS_LIMITS: OrgFsLimits = {
  maxFileBytes: 5 * 1024 * 1024,
  volumeQuotaBytes: 64 * 1024 * 1024,
};

/** Hard ceiling on a single avatar upload. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/**
 * How many pictures a user keeps, current one included. Past avatars are worth
 * keeping — re-picking one is the common case — but the list is a convenience,
 * not an archive, so the oldest falls off rather than growing into the volume
 * quota and failing a later upload with a confusing error.
 */
const MAX_AVATAR_HISTORY = 5;

/** A recognized raster image: its media type and the extension we store it under. */
export interface AvatarType {
  mime: string;
  ext: string;
}

function startsWith(bytes: Uint8Array, signature: number[], at = 0): boolean {
  return signature.every((byte, i) => bytes[at + i] === byte);
}

/**
 * Identify an avatar from its leading bytes, or null if it is not one of the
 * four raster formats we accept.
 *
 * Deliberately ignores the request's `Content-Type`: the stored file's
 * extension decides the type the public read route later serves it as, so
 * trusting a client header would let anyone publish arbitrary bytes under an
 * image label. SVG is absent by design — it can carry script, and these bytes
 * are readable by anyone with the link, so accepting it would turn a profile
 * picture into stored XSS on our own origin.
 */
export function sniffAvatarType(bytes: Uint8Array): AvatarType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: "image/png", ext: "png" };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  // "GIF87a" / "GIF89a"
  if (
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return { mime: "image/gif", ext: "gif" };
  }
  // "RIFF" .... "WEBP"
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

/**
 * A user id is used verbatim as a volume name, so it has to satisfy the org-fs
 * volume grammar. Better Auth ids do; a future id format that doesn't must not
 * silently land in a mangled volume.
 */
export function isValidUserVolume(userId: string): boolean {
  return isValidVolume(userId);
}

/**
 * Content-addressed avatar path: identical bytes reuse the key, so a re-upload
 * of the same picture is idempotent and costs no extra storage.
 */
export function avatarPath(bytes: Uint8Array, ext: string): string {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `${AVATAR_DIR}/${digest}.${ext}`;
}

/** Same-origin, membership-free URL for a file in a user's volume. */
export function userFsReadUrl(
  baseUrl: string,
  userId: string,
  path: string,
): string {
  const qs = new URLSearchParams({ path }).toString();
  return `${baseUrl.replace(/\/$/, "")}${USER_FS_API_PREFIX}/fs/${encodeURIComponent(userId)}/read?${qs}`;
}

/**
 * An OrgFs bound to the user-filesystem scope. Mirrors `buildPublicOrgFs`:
 * missing S3 falls back to the dev object storage, so this always returns a
 * working instance.
 */
export function buildUserFs(ctx: StudioContext): OrgFs {
  const s3Service = getObjectStorageS3Service();
  const storage = s3Service
    ? createBoundObjectStorage(s3Service, USER_FS_ORG_ID)
    : new DevObjectStorage(USER_FS_ORG_ID, ctx.baseUrl);
  return new OrgFs(
    storage,
    ctx.storage.orgFsEntries,
    USER_FS_ORG_ID,
    USER_FS_LIMITS,
  );
}

/** A stored avatar: `current` is the one `user.image` points at. */
export interface StoredAvatar {
  path: string;
  current: boolean;
  updatedAt: string;
}

/** Avatar files newest-first. Directories and the deleted are already out. */
async function listAvatarFiles(fs: OrgFs, userId: string) {
  const entries = await fs.listDir(userId, AVATAR_DIR).catch(() => []);
  return entries
    .filter((e) => e.kind === "file")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The user's pictures, newest first. */
export async function listUserAvatars(
  fs: OrgFs,
  userId: string,
): Promise<StoredAvatar[]> {
  const files = await listAvatarFiles(fs, userId);
  return files.map((e) => ({
    path: e.path,
    current: e.readPublic,
    updatedAt: e.updatedAt,
  }));
}

/**
 * Only the picture in use is world-readable; the rest of the history stays
 * private and is visible to its owner alone (the read route already serves an
 * owner their own private files). Publishing the whole directory instead would
 * leave every avatar a person ever picked permanently fetchable by anyone who
 * kept the link.
 */
async function ensureHistoryPrivate(fs: OrgFs, userId: string): Promise<void> {
  const dir = await fs.stat(userId, AVATAR_DIR);
  if (dir?.readPublic) {
    await fs.setReadPublic(userId, AVATAR_DIR, false, { actor: userId });
  }
}

/**
 * Point `user.image`'s target at `path`. Publishes before un-publishing, so
 * there is never an instant with no readable avatar; the reverse order would
 * show a broken image to anyone loading the page right then.
 */
export async function setCurrentAvatar(
  fs: OrgFs,
  userId: string,
  path: string,
): Promise<void> {
  const files = await listAvatarFiles(fs, userId);
  if (!files.some((e) => e.path === path)) {
    throw new OrgFsNotFoundError(`No such avatar: ${path}`);
  }

  await ensureHistoryPrivate(fs, userId);
  await fs.setReadPublic(userId, path, true, { actor: userId });
  await Promise.all(
    files
      .filter((e) => e.path !== path && e.readPublic)
      .map((e) => fs.setReadPublic(userId, e.path, false, { actor: userId })),
  );
}

/**
 * Drop the oldest pictures past the cap, never the one in use — after a pick
 * from history the current avatar is not the newest file.
 */
async function evictBeyondCap(
  fs: OrgFs,
  userId: string,
  keepPath: string,
): Promise<void> {
  try {
    const files = await listAvatarFiles(fs, userId);
    const excess = files
      .filter((e) => e.path !== keepPath)
      .slice(MAX_AVATAR_HISTORY - 1);
    await Promise.all(
      excess.map((e) => fs.delete(userId, e.path, { actor: userId })),
    );
  } catch (err) {
    console.warn("[user-fs] failed to evict old avatars", err);
  }
}

/**
 * Store `bytes` as the user's current avatar and return its path.
 *
 * Ordering is failure-shaped: write, publish, then evict. A crash after the
 * write leaves an unreferenced file (reclaimed by the next upload's eviction);
 * a crash before the evict leaves an extra picture in the history, which is
 * harmless. Evicting first could delete the only avatar there is.
 */
export async function putUserAvatar(
  fs: OrgFs,
  opts: { userId: string; bytes: Uint8Array; contentType: string; ext: string },
): Promise<string> {
  const { userId, bytes, contentType, ext } = opts;
  const path = avatarPath(bytes, ext);

  await fs.write(userId, path, bytes, { actor: userId, contentType });
  await setCurrentAvatar(fs, userId, path);
  await evictBeyondCap(fs, userId, path);

  return path;
}

/** Delete one stored picture. */
export async function deleteUserAvatar(
  fs: OrgFs,
  userId: string,
  path: string,
): Promise<void> {
  const files = await listAvatarFiles(fs, userId);
  if (!files.some((e) => e.path === path)) {
    throw new OrgFsNotFoundError(`No such avatar: ${path}`);
  }
  await fs.delete(userId, path, { actor: userId });
}

/**
 * Delete every stored picture. Best-effort: a leftover file is invisible to
 * users and costs a few KB, so a failure here must not fail the caller.
 */
export async function pruneAvatars(fs: OrgFs, userId: string): Promise<void> {
  try {
    const files = await listAvatarFiles(fs, userId);
    await Promise.all(
      files.map((e) => fs.delete(userId, e.path, { actor: userId })),
    );
  } catch (err) {
    console.warn("[user-fs] failed to clear avatars", err);
  }
}
