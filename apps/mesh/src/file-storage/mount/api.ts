/**
 * The minimal filesystem surface the WebDAV serve layer needs. Two
 * implementations exist:
 *   - `OrgFsClient` (client.ts) — talks to the studio `/api/:org/fs/:volume/*`
 *     HTTP contract; this is what the daemon uses (it has no DB/storage).
 *   - a direct adapter over the in-process `OrgFs` service — used by tests and
 *     the end-to-end mount harness.
 *
 * Keeping the WebDAV handler behind this interface lets it be exercised without
 * the cluster (and keeps the daemon bundle free of cluster deps).
 */

export interface OrgFsNode {
  /** Normalized path, no leading/trailing slash. "" is the volume root. */
  path: string;
  kind: "file" | "dir";
  size: number;
  /** ISO timestamp; used for getlastmodified. */
  updatedAt: string;
}

export interface OrgFsApi {
  /** Immediate children of a directory (path "" = root). */
  listDir(path: string): Promise<OrgFsNode[]>;
  /** Metadata for one entry, or null if absent. */
  stat(path: string): Promise<OrgFsNode | null>;
  /** Full bytes of a file. Throws OrgFsApiError(404) if not a live file. */
  read(path: string): Promise<Uint8Array>;
  /**
   * Stream a file read straight from the byte store (presigned URL), pushing
   * an optional `Range` header down so only the requested bytes move — where
   * `read()` buffers every byte through the studio and this process. Returns
   * null when no streamable URL is available (presign failed, or dev storage's
   * inline `data:` URLs); callers then fall back to `read()`. Throws
   * OrgFsApiError(404) for a missing file.
   */
  readResponse?(path: string, range?: string): Promise<Response | null>;
  /** Create/overwrite a file. */
  write(path: string, body: Uint8Array, contentType?: string): Promise<void>;
  /** Create a directory (and ancestors). */
  mkdir(path: string): Promise<void>;
  /** Delete a file, or a directory and everything under it. */
  remove(path: string): Promise<void>;
  /** Move/rename. */
  move(from: string, to: string): Promise<void>;
}

/** Carries an HTTP-ish status so the WebDAV layer can map it to a response. */
export class OrgFsApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OrgFsApiError";
  }
}
