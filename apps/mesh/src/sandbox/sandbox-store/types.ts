/**
 * SandboxStore — blob store interface for full-workdir snapshots (plain `.tar`).
 *
 * One snapshot per (orgId, virtualMcpId, branch). Two adapters land in this
 * package: LocalFsStore (writes under <DATA_DIR>/sandbox-snapshots) and
 * S3Store (SigV4/IRSA). Selection happens once at boot in `./index.ts`.
 *
 * Bytes flow daemon → mesh → store on save, and store → mesh → daemon on
 * restore. The store never holds workdir credentials; mesh is the only thing
 * that knows S3 vs local. See SANDBOX_PERSISTENCE.md.
 */

export interface SandboxSnapshotKey {
  orgId: string;
  virtualMcpId: string;
  branch: string;
}

export interface SnapshotHead {
  /** Size of the stored bundle in bytes. */
  size: number;
  /** Backend-specific identifier (S3 ETag, file mtime hex for local). */
  etag: string;
}

export interface SandboxStore {
  /** Atomic write — partial uploads must never overwrite a prior snapshot. */
  put(
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
  ): Promise<void>;

  /** Returns null when absent. */
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;

  /** Existence + size probe. Returns null when absent. */
  head(key: string): Promise<SnapshotHead | null>;

  /** Idempotent — missing key is a no-op. */
  delete(key: string): Promise<void>;
}

/**
 * Build the storage key for a snapshot.
 *
 * Key shape: `<orgId>/<virtualMcpId>/<branch>.tar`. Branch may contain `/`
 * (e.g. `deco/lucky-dolphin`); each path component is sanitized
 * independently so the slashes survive as legitimate prefix hierarchy in
 * S3 and as nested directories on the local filesystem.
 *
 * Sanitization rules: allow `[a-zA-Z0-9._-]`, replace everything else with
 * `_`, collapse leading dots so `..` cannot survive as a component name.
 * This neutralizes path-traversal attempts in the branch field before they
 * reach `LocalFsStore`, even though that store double-checks via
 * `path.relative` as defense in depth.
 */
export function snapshotKey({
  orgId,
  virtualMcpId,
  branch,
}: SandboxSnapshotKey): string {
  if (!orgId) throw new Error("snapshotKey: orgId is required");
  if (!virtualMcpId) throw new Error("snapshotKey: virtualMcpId is required");
  if (!branch) throw new Error("snapshotKey: branch is required");

  const branchSan = branch
    .split("/")
    .map(sanitizeComponent)
    .filter((s) => s.length > 0)
    .join("/");
  if (!branchSan) {
    throw new Error(`snapshotKey: branch sanitized to empty: ${branch}`);
  }
  return `${sanitizeComponent(orgId)}/${sanitizeComponent(virtualMcpId)}/${branchSan}.tar`;
}

function sanitizeComponent(s: string): string {
  // Replace anything outside [a-zA-Z0-9._-] with `_`. Then collapse leading
  // dots so a component can't start with `.` (blocks `..`, `.git`, etc.
  // appearing as standalone path segments).
  const replaced = s.replace(/[^a-zA-Z0-9._-]/g, "_");
  return replaced.replace(/^\.+/, "_");
}
