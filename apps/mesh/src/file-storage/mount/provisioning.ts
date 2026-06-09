/**
 * Builds the `ORGFS_CONFIG` payload the mesh pushes to a sandbox daemon (as a
 * boot env var) to turn on org-fs mounting. The daemon's `parseOrgFsConfig`
 * (packages/sandbox/daemon/org-fs/config.ts) validates this shape.
 *
 * The mounted set is hardcoded for now (per the team decision); later this
 * becomes per-agent configurable. Two volumes:
 *   - `skills`  → mounted at `<appRoot>/org/skills` (org-wide shared library)
 *   - `outputs` → mounted at `<appRoot>/org/.outputs` (hidden); the daemon
 *     repoints a per-run symlink `<appRoot>/org/output → .outputs/<threadId>`
 *     so the agent sees a bare `output/` that is, externally, that thread's
 *     subtree of the org-wide `outputs` volume (the share-files-back flow).
 */

/** Shape the daemon parses from ORGFS_CONFIG (mirrors OrgFsMountConfig). */
export interface OrgFsProvisionConfig {
  baseUrl: string;
  orgSlug: string;
  token: string;
  mounts: { volume: string; path: string }[];
}

/** Hidden mount point for the outputs volume; the per-run `output` symlink
 *  (daemon-side) points into here. Kept distinct from `skills` so a stray
 *  `output` symlink never collides with a real volume mount. */
const ORG_FS_OUTPUTS_MOUNT_PATH = ".outputs";

const DEFAULT_MOUNTS: ReadonlyArray<{ volume: string; path: string }> = [
  { volume: "skills", path: "skills" },
  { volume: "outputs", path: ORG_FS_OUTPUTS_MOUNT_PATH },
];

export function buildOrgFsConfig(opts: {
  baseUrl: string;
  orgSlug: string;
  token: string;
}): OrgFsProvisionConfig {
  return {
    baseUrl: opts.baseUrl.replace(/\/+$/, ""),
    orgSlug: opts.orgSlug,
    token: opts.token,
    mounts: DEFAULT_MOUNTS.map((m) => ({ ...m })),
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
      expiresIn: ORG_FS_KEY_TTL_SECONDS,
      metadata: { organization: { id: opts.orgId, slug: opts.orgSlug } },
    });
    return JSON.stringify(
      buildOrgFsConfig({
        baseUrl: opts.baseUrl,
        orgSlug: opts.orgSlug,
        token: apiKey.key,
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
