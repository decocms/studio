/**
 * Pure config types for org-fs mounting, shared by the daemon's `TenantConfig`
 * (types.ts) and the `MountManager`. Kept import-free so `types.ts` doesn't
 * pull in the mount-manager's runtime dependencies.
 */

/** One mountable volume → where it lands in the workspace. */
export interface OrgFsVolumeMount {
  readonly volume: string;
  /** Mount point; relative paths resolve under `<appRoot>/org/`. */
  readonly path: string;
  /** Mount read-only (the shared public skill sets). */
  readonly readonly?: boolean;
}

/** Studio-pushed config that turns on org-fs mounting for a sandbox. */
export interface OrgFsMountConfig {
  /** Studio base URL the daemon calls (e.g. https://cluster.example). */
  readonly baseUrl: string;
  /** Immutable org slug (the `:org` path segment). */
  readonly orgSlug: string;
  /** Bearer token authorizing ORG_FS_READ/WRITE (an fs-scoped API key). */
  readonly token: string;
  readonly mounts: readonly OrgFsVolumeMount[];
}

/**
 * Parse the daemon's `ORGFS_CONFIG` boot env (a JSON `OrgFsMountConfig`). The
 * studio sets it at spawn (like `OFFLOAD_ALLOWED_HOSTS`) rather than via a
 * post-boot config push, so it's available when the daemon reads it at boot.
 * Returns null for absent/malformed/empty config (mounting is then skipped).
 */
export function parseOrgFsConfig(
  raw: string | undefined,
): OrgFsMountConfig | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const c = parsed as Record<string, unknown>;
  if (
    typeof c.baseUrl !== "string" ||
    typeof c.orgSlug !== "string" ||
    typeof c.token !== "string" ||
    !Array.isArray(c.mounts)
  ) {
    return null;
  }
  const mounts = c.mounts.filter(
    (m): m is OrgFsVolumeMount =>
      typeof m === "object" &&
      m !== null &&
      typeof (m as OrgFsVolumeMount).volume === "string" &&
      typeof (m as OrgFsVolumeMount).path === "string" &&
      ((m as OrgFsVolumeMount).readonly === undefined ||
        typeof (m as OrgFsVolumeMount).readonly === "boolean"),
  );
  if (mounts.length === 0) return null;
  return { baseUrl: c.baseUrl, orgSlug: c.orgSlug, token: c.token, mounts };
}
