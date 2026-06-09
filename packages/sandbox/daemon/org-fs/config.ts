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
}

/** Mesh-pushed config that turns on org-fs mounting for a sandbox. */
export interface OrgFsMountConfig {
  /** Mesh base URL the daemon calls (e.g. https://cluster.example). */
  readonly baseUrl: string;
  /** Immutable org slug (the `:org` path segment). */
  readonly orgSlug: string;
  /** Bearer token authorizing ORG_FS_READ/WRITE (an fs-scoped API key). */
  readonly token: string;
  readonly mounts: readonly OrgFsVolumeMount[];
}
