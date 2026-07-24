/**
 * Public skill sets: readonly org-fs volumes shared by EVERY organization,
 * each synced from a public GitHub repo (see skill-set-sync.ts) and mounted
 * into every sandbox at `org/public/<set>`.
 *
 * Mechanics: the shared content lives under a dedicated system organization
 * row (`org_fs_entry.organization_id` FKs `organization.id`, so the scope is
 * a real org — seeded by migration 107, no members, unreachable as a normal
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
const PUBLIC_VOLUME_PREFIX = "public-";

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
 * Built-in skill sets, present in EVERY deployment with no configuration —
 * so a freshly-cloned local studio (and any prod deploy) pulls the core
 * skills automatically. `core` is the canonical skill source: the
 * file-handling skills (pptx/docx/xlsx/pdf/file-reading) plus slides +
 * templating, synced from the studio repo and mounted read-only at
 * `org/public/core`. This is what replaces the image-baked
 * `/mnt/skills/public`.
 *
 * `ORGFS_PUBLIC_SETS` does NOT replace these — it overrides by set name
 * and adds new sets (env wins on a name collision). So a deployment can
 * repoint `core` (e.g. at a pinned ref) or add its own sets without
 * losing the built-ins.
 */
export const DEFAULT_PUBLIC_SETS: PublicSkillSetSource[] = [
  {
    set: "core",
    repo: "decocms/studio",
    ref: "main",
    paths: [{ from: "packages/sandbox/image/skills" }],
  },
  {
    set: "storefront",
    repo: "decocms/storefront-skills",
    ref: "main",
    paths: [
      { from: ".claude-seo/skills" },
      { from: ".claude-performance/skills" },
      { from: ".claude-deco/skills" },
    ],
  },
];

const setsSchema = z
  .array(setSchema)
  // Duplicate names share one volume — each sync cycle would delete the
  // other entry's files (permanent churn). Route the misconfig to the
  // warn-and-disable branch instead.
  .refine((sets) => new Set(sets.map((s) => s.set)).size === sets.length, {
    message: "duplicate set names",
  });

/**
 * Resolve the effective public sets from a raw `ORGFS_PUBLIC_SETS` value:
 * the hardcoded defaults, then the parsed env overlaid by set name (env
 * wins). Malformed env is ignored with a warn — it must never break boot,
 * and never drop the defaults. Pure (no settings/IO) so it's unit-testable.
 */
export function resolvePublicSets(
  raw: string | undefined,
): PublicSkillSetSource[] {
  const byName = new Map<string, PublicSkillSetSource>(
    DEFAULT_PUBLIC_SETS.map((s) => [s.set, s]),
  );
  if (raw) {
    try {
      for (const s of setsSchema.parse(JSON.parse(raw))) byName.set(s.set, s);
    } catch (err) {
      console.warn(
        "[org-fs] invalid ORGFS_PUBLIC_SETS — using built-in defaults only",
        err,
      );
    }
  }
  return [...byName.values()];
}

/** The deployment's effective public sets (defaults + env override). */
export function getPublicSets(): PublicSkillSetSource[] {
  return resolvePublicSets(getSettings().orgFsPublicSetsJson);
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
