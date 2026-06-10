/**
 * Public skill sets: readonly org-fs volumes shared by EVERY organization,
 * each synced from a public GitHub repo (see skill-set-sync.ts) and mounted
 * into every sandbox at `org/public/<set>`.
 *
 * Mechanics: the shared content lives under a dedicated system organization
 * row (`org_fs_entry.organization_id` FKs `organization.id`, so the scope is
 * a real org — seeded by migration 106, no members, unreachable as a normal
 * org). Volume names carry the `public-` prefix; the fs routes resolve them
 * to this scope, allow reads for any authenticated member, and reject writes
 * (the syncer writes server-side through `OrgFs` directly, never over HTTP).
 */

import { z } from "zod";
import { getSettings } from "../settings";
import { getObjectStorageS3Service } from "../object-storage/factory";
import { createBoundObjectStorage } from "../object-storage/bound-object-storage";
import { DevObjectStorage } from "../object-storage/dev-object-storage";
import type { StudioContext } from "../core/studio-context";
import { OrgFs } from "./org-fs";

export const ORG_FS_PUBLIC_ORG_ID = "org_orgfs_public_skills";
export const ORG_FS_PUBLIC_ORG_SLUG = "orgfs-public-skills";
export const PUBLIC_VOLUME_PREFIX = "public-";

export function isPublicVolume(volume: string): boolean {
  return volume.startsWith(PUBLIC_VOLUME_PREFIX);
}

export function publicVolumeForSet(set: string): string {
  return `${PUBLIC_VOLUME_PREFIX}${set}`;
}

const sourcePathSchema = z.object({
  /** Repo subtree whose CHILDREN sync into the volume (e.g. ".claude-seo/skills"). */
  from: z.string(),
  /** Volume subdir to land under; "" / absent = volume root. */
  to: z.string().optional(),
});

const setSchema = z.object({
  /** Set name — becomes volume `public-<set>` mounted at `org/public/<set>`. */
  set: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
  /** GitHub `owner/repo` (public). */
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  /** Branch, tag, or commit SHA. */
  ref: z.string().min(1),
  paths: z.array(sourcePathSchema).min(1),
});

export type PublicSkillSetSource = z.infer<typeof setSchema>;

/**
 * Parse the deployment's ORGFS_PUBLIC_SETS (a JSON array of sets). Malformed
 * config returns [] with a warn — public sets must never break boot.
 */
const setsSchema = z
  .array(setSchema)
  // Duplicate names share one volume — each sync cycle would delete the
  // other entry's files (permanent churn). Route the misconfig to the
  // warn-and-disable branch instead.
  .refine((sets) => new Set(sets.map((s) => s.set)).size === sets.length, {
    message: "duplicate set names",
  });

export function getPublicSets(): PublicSkillSetSource[] {
  const raw = getSettings().orgFsPublicSetsJson;
  if (!raw) return [];
  try {
    return setsSchema.parse(JSON.parse(raw));
  } catch (err) {
    console.warn(
      "[org-fs] invalid ORGFS_PUBLIC_SETS — public sets disabled",
      err,
    );
    return [];
  }
}

/**
 * An OrgFs bound to the shared public scope (mirrors the per-org rebind in
 * resolve-org-from-path.ts — like there, missing S3 falls back to the dev
 * object storage, so this always returns a working instance).
 */
export function buildPublicOrgFs(ctx: StudioContext): OrgFs {
  const s3Service = getObjectStorageS3Service();
  const storage = s3Service
    ? createBoundObjectStorage(s3Service, ORG_FS_PUBLIC_ORG_ID)
    : new DevObjectStorage(ORG_FS_PUBLIC_ORG_ID, ctx.baseUrl);
  return new OrgFs(storage, ctx.storage.orgFsEntries, ORG_FS_PUBLIC_ORG_ID);
}
