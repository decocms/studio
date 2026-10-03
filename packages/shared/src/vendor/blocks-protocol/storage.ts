/**
 * The storage interface a content-protocol backend implements.
 *
 * A storage is deliberately small: a snapshot of file names and versions,
 * reading file bodies, reading the schema, and one atomic commit attempt.
 * The protocol core (`createContentHandler`) owns everything else: the
 * JSON-RPC layer, validation, the file-name rule, the secret guard, limits and
 * retries. Storages deal in *files* inside `<root>/.deco/blocks`; entry names
 * are the core's business.
 *
 * Browser-safe: types and small error classes only.
 */
import type { Limits, StorageKind } from "./types";

/** What a storage tells `describe`. */
export interface StorageDescription {
  kind: StorageKind;
  /** The app root, relative to the repository root (`"."` when they're the same). */
  root: string;
  readOnly: boolean;
  /** Branch support; `null` when the storage has no refs (`ref` params are then Unsupported). */
  refs: null | { default: string; autoCreate: boolean };
  /** Where uploads go; `null` when read-only or uploads go elsewhere. */
  assets: null | { dir: string; maxBytes: number };
  /**
   * Durable request-key receipts. Advertise only when `getReceipt` is
   * implemented and `commit` persists `attempt.receipt` with the mutation.
   */
  idempotency: null | { retentionMs: number };
  /** Overrides the poll interval (default: 2000 for a working tree, 30000 for git). */
  pollIntervalMs?: number;
  /** Lowers the protocol's default limits. Higher values are ignored. */
  limits?: Partial<Limits>;
}

/** One saved-block file in a snapshot. */
export interface StorageFile {
  /** The file name inside `.deco/blocks`, such as `pages-Home.json`. */
  file: string;
  /** An opaque version of the file's content, compared only for equality. */
  version: string;
  /** The file's size in bytes, when the storage knows it without reading the body. */
  size?: number;
}

/** Every saved-block file at one point in time. */
export interface StorageSnapshot {
  /** An opaque revision of the whole set, compared only for equality. */
  revision: string;
  /** The ref actually read (it can differ from the requested one); `null` without refs. */
  resolvedRef: string | null;
  files: StorageFile[];
}

/** A file body as read, with the version of the bytes actually read. */
export interface StoredFileBody {
  /** The file's UTF-8 content. */
  text: string;
  /**
   * The version of exactly these bytes, computed the way snapshots compute
   * versions. It differs from the snapshot's when the file changed in between.
   */
  version: string;
}

/** The schema file, as stored. */
export interface StoredSchema {
  /** An opaque version of the schema bytes. */
  version: string;
  /** The raw file content (`schema.gen.json`, else `meta.gen.json`). */
  text: string;
  resolvedRef: string | null;
}

/** A durable receipt for one `blocks.apply` request key. */
export interface StoredReceipt {
  /** The canonical digest of the request the key was first used with. */
  digest: string;
  /** The revision that commit produced. */
  revision: string;
  /** The versions of the files that commit wrote. */
  versions: Record<string, string>;
  /** The files that commit deleted (`attempt.delete`), so a replay reports the same names. */
  deleted?: string[];
}

/** One atomic commit attempt. */
export interface CommitAttempt {
  ref?: string;
  /** The snapshot the core validated against. */
  base: StorageSnapshot;
  /** Files to write, by file name, with their full content. */
  put: Record<string, string>;
  /** Files to delete. A file that's already gone is fine. */
  delete: string[];
  /**
   * Versions the files must still have for the commit to land (`null` = must
   * not exist). A storage MUST reject the attempt as stale when any of them
   * changed, and MAY reject it when anything else changed since `base`.
   */
  expected: Record<string, string | null>;
  /**
   * The schema version the core validated against (`null` = no schema), when
   * the write depends on it (`ifSchemaMatch`, or the secret guard). When set,
   * a storage MUST reject the attempt as stale if the schema's version at
   * commit time differs, checked atomically with `expected`.
   */
  expectedSchemaVersion?: string | null;
  /**
   * Persist this receipt atomically with the mutation (only when idempotency
   * is advertised). The key also reserves the request: a storage MUST reject
   * the attempt as stale when a receipt for `receipt.key` already exists,
   * including one written concurrently by another replica, so two requests
   * with the same key never both commit.
   */
  receipt?: { key: string; digest: string };
}

export type CommitResult =
  | {
      status: "committed";
      revision: string;
      /** The new version of every file in `put`. */
      versions: Record<string, string>;
    }
  | { status: "stale" };

export interface ContentStorage {
  describe(): StorageDescription | Promise<StorageDescription>;
  /**
   * Lists the saved-block files. Throws `StorageNotFoundError` when there's no
   * `.deco` folder at all, or the ref can't be read.
   */
  snapshot(options: { ref?: string }): Promise<StorageSnapshot>;
  /**
   * Reads file bodies (UTF-8 text) from a snapshot, each with the version of
   * the bytes read. A file that vanished is left out. A storage that can't
   * read at the snapshot (a working tree) returns current bytes; the core
   * compares versions to notice.
   */
  readFiles(
    snapshot: StorageSnapshot,
    files: string[],
  ): Promise<Record<string, StoredFileBody>>;
  /** Reads `schema.gen.json`, falling back to `meta.gen.json`; `null` when neither exists. */
  readSchema(options: { ref?: string }): Promise<StoredSchema | null>;
  /** Reads `<root>/.deco/secrets.pub`; `null` without one. */
  readSecretsPublicKey(): Promise<string | null>;
  /** One all-or-nothing commit attempt; durable when it resolves. */
  commit(attempt: CommitAttempt): Promise<CommitResult>;
  /** Looks up a receipt by its scoped key; `null` when unknown or expired. */
  getReceipt?(key: string): Promise<StoredReceipt | null>;
  /** Stores an uploaded file, never overwriting one; returns the stored file name. */
  putAsset?(name: string, body: Uint8Array): Promise<{ name: string }>;
}

/** Thrown by a storage when there's no `.deco` folder, or a ref can't be read or created. */
export class StorageNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageNotFoundError";
  }
}

/**
 * Thrown by a storage asked to touch a file that can't be a saved block (a
 * dotfile, a path). The core refuses those names first; this is the backstop.
 */
export class StorageInvalidFileError extends Error {
  constructor(readonly file: string) {
    super(`not a saved-block file name: ${JSON.stringify(file)}`);
    this.name = "StorageInvalidFileError";
  }
}

/** Thrown by a storage when it failed or is rate-limited. */
export class StorageUnavailableError extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "StorageUnavailableError";
    this.retryAfterMs = retryAfterMs;
  }
}
