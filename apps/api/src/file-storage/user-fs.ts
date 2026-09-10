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
import { OrgFs, type OrgFsLimits } from "./org-fs";
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
 * Raster image types only, mapped to the extension the read route infers the
 * content-type back from. SVG is deliberately absent: it can carry script, and
 * an avatar is served to anyone with the link — hoisting it would turn a
 * profile picture into stored XSS on our own origin.
 */
const AVATAR_EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** The upload's extension, or null when the type is not an allowed image. */
export function avatarExtension(
  contentType: string | undefined,
): string | null {
  if (!contentType) return null;
  const mime = contentType.split(";")[0]!.trim().toLowerCase();
  return AVATAR_EXT_BY_MIME[mime] ?? null;
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

/**
 * Store `bytes` as the user's avatar and return its path.
 *
 * Ordering is failure-shaped: write, publish, then prune. A crash after the
 * write leaves an unreferenced file (reclaimed by the next upload's prune); a
 * crash before the prune leaves the *old* avatar behind, which still renders.
 * Pruning first would risk a window with no avatar at all.
 */
export async function putUserAvatar(
  fs: OrgFs,
  opts: { userId: string; bytes: Uint8Array; contentType: string; ext: string },
): Promise<string> {
  const { userId, bytes, contentType, ext } = opts;
  const path = avatarPath(bytes, ext);

  await fs.write(userId, path, bytes, { actor: userId, contentType });
  await fs.setReadPublic(userId, AVATAR_DIR, true, { actor: userId });
  await pruneAvatars(fs, userId, path);

  return path;
}

/**
 * Drop every avatar file except `keepPath` (pass none to clear them all).
 * Best-effort: a stale file is invisible to users and costs a few KB, so a
 * failure here must not fail the upload that just succeeded.
 */
export async function pruneAvatars(
  fs: OrgFs,
  userId: string,
  keepPath?: string,
): Promise<void> {
  try {
    const entries = await fs.listDir(userId, AVATAR_DIR);
    await Promise.all(
      entries
        .filter((e) => e.kind === "file" && e.path !== keepPath)
        .map((e) => fs.delete(userId, e.path, { actor: userId })),
    );
  } catch (err) {
    console.warn("[user-fs] failed to prune old avatars", err);
  }
}
