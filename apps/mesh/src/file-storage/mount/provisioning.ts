/**
 * Builds the `ORGFS_CONFIG` payload the studio pushes to a sandbox daemon (as a
 * boot env var) to turn on org-fs mounting. The daemon's `parseOrgFsConfig`
 * (packages/sandbox/daemon/org-fs/config.ts) validates this shape.
 *
 * The mounted set is hardcoded for now (per the team decision); later this
 * becomes per-agent configurable. Three volumes (org skills are deliberately
 * NOT a cloud volume — skills belong in versioned repos, surfaced through
 * the read-only public sets):
 *   - `home`    → mounted at `<appRoot>/org/home` (visible, editable):
 *     the org's shared home folder, free-form — members and agents organize
 *     it with whatever subfolders they want, and knowledge accumulates
 *     across every run (no per-thread scoping). Both the volume NAME and the
 *     mount path are the fixed `home`, so `org/home/` is a stable path that
 *     prompts, skills, and code can hardcode. The Library shows the org's
 *     slug as this folder's display label (see `homeDisplayName`).
 *   - `outputs` → mounted at `<appRoot>/org/.outputs` (hidden); the daemon
 *     repoints a per-run symlink `<appRoot>/org/output → .outputs/<threadId>`
 *     so the agent sees a bare `output/` that is, externally, that thread's
 *     subtree of the org-wide `outputs` volume (the share-files-back flow).
 *   - `uploads` → mounted at `<appRoot>/org/.uploads` (hidden); same per-run
 *     symlink trick (`org/upload → .uploads/<threadId>`) in the inbound
 *     direction — chat attachments the studio writes to the thread's uploads
 *     folder appear in the sandbox with no copy step.
 */

import { HOME_MOUNT_PATH } from "../home-mount";
import {
  getPublicSets,
  isPublicVolume,
  publicVolumeForSet,
} from "../public-sets";

/** Shape the daemon parses from ORGFS_CONFIG (mirrors OrgFsMountConfig). */
export interface OrgFsProvisionConfig {
  baseUrl: string;
  orgSlug: string;
  token: string;
  mounts: { volume: string; path: string; readonly?: boolean }[];
}

/** Hidden mount points for the per-thread volumes; the per-run `output` /
 *  `upload` symlinks (daemon-side) point into these. Kept distinct from
 *  `skills` so a stray symlink never collides with a real volume mount. */
const ORG_FS_OUTPUTS_MOUNT_PATH = ".outputs";
const ORG_FS_UPLOADS_MOUNT_PATH = ".uploads";

const DEFAULT_MOUNTS: ReadonlyArray<{ volume: string; path: string }> = [
  { volume: "outputs", path: ORG_FS_OUTPUTS_MOUNT_PATH },
  { volume: "uploads", path: ORG_FS_UPLOADS_MOUNT_PATH },
];

/**
 * The sandbox path an org-fs (volume, path) is reachable at inside a run —
 * the inverse of the mount table above. Lets server-side code (e.g. the agent
 * knowledge block) tell the agent exactly where to read an attached file.
 * Slug-independent: the home volume always mounts at the fixed `org/home`.
 * `path` "" returns the volume's mount root.
 */
export function orgFsSandboxPath(volume: string, path: string): string {
  let base: string;
  if (volume === "home") base = `org/${HOME_MOUNT_PATH}`;
  else if (volume === "outputs") base = `org/${ORG_FS_OUTPUTS_MOUNT_PATH}`;
  else if (volume === "uploads") base = `org/${ORG_FS_UPLOADS_MOUNT_PATH}`;
  else if (isPublicVolume(volume)) {
    base = `org/public/${volume.slice("public-".length)}`;
  } else base = `org/${volume}`;
  return path ? `${base}/${path}` : base;
}

export function buildOrgFsConfig(opts: {
  baseUrl: string;
  orgSlug: string;
  token: string;
  /** Public skill sets to mount readonly at `org/public/<set>`. */
  publicSets?: string[];
}): OrgFsProvisionConfig {
  return {
    baseUrl: opts.baseUrl.replace(/\/+$/, ""),
    orgSlug: opts.orgSlug,
    token: opts.token,
    mounts: [
      // The org's home folder mounts at the fixed `org/home` (hardcodable path).
      { volume: "home", path: HOME_MOUNT_PATH },
      ...DEFAULT_MOUNTS.map((m) => ({ ...m })),
      ...(opts.publicSets ?? []).map((set) => ({
        volume: publicVolumeForSet(set),
        path: `public/${set}`,
        readonly: true,
      })),
    ],
  };
}

/** API-key lifetime for the org-fs token baked into a sandbox's ORGFS_CONFIG.
 *  Sandboxes are ephemeral and re-provisioned (re-minting) on restart, so a
 *  generous fixed TTL is fine for now; tie to the sandbox lifecycle later. */
const ORG_FS_KEY_TTL_SECONDS = 60 * 60 * 24 * 7;

/**
 * Mint an org-fs API key for the caller and return the JSON `ORGFS_CONFIG` the
 * daemon mounts from — or `undefined` if minting fails (mounting is then simply
 * skipped; never breaks sandbox provisioning). Used by both sandbox-ensure
 * paths (SANDBOX_START + dispatch), desktop-only.
 */
export async function mintOrgFsConfigJson(
  ctx: {
    boundAuth: {
      apiKey: {
        create(data: {
          name: string;
          permissions?: Record<string, string[]>;
          expiresIn?: number;
          metadata?: Record<string, unknown>;
        }): Promise<{ key: string }>;
      };
    };
  },
  opts: { orgSlug: string; orgId: string; baseUrl: string },
): Promise<string | undefined> {
  try {
    const apiKey = await ctx.boundAuth.apiKey.create({
      name: `orgfs-${opts.orgSlug}`,
      // This credential is baked into the sandbox mount and may be read by
      // every collaborator in a shared hosted workspace. Keep it restricted
      // to the two org-fs operations instead of carrying the creator's full
      // management permissions.
      permissions: { self: ["ORG_FS_READ", "ORG_FS_WRITE"] },
      expiresIn: ORG_FS_KEY_TTL_SECONDS,
      metadata: { organization: { id: opts.orgId, slug: opts.orgSlug } },
    });
    return JSON.stringify(
      buildOrgFsConfig({
        baseUrl: opts.baseUrl,
        orgSlug: opts.orgSlug,
        token: apiKey.key,
        publicSets: getPublicSets().map((s) => s.set),
      }),
    );
  } catch (err) {
    console.warn(
      "[org-fs] token mint failed; mounts disabled for this sandbox",
      err,
    );
    return undefined;
  }
}
