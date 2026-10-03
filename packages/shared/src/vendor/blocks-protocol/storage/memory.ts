/**
 * `@decocms/blocks/protocol/storage/memory`: an in-memory `ContentStorage`.
 *
 * A reference implementation of the storage contract, including durable
 * request-key receipts persisted atomically with each commit, and a fixture
 * for tests: its state can be dumped and restored to simulate a restart, and
 * hooks let a test change files between a snapshot and a commit. Browser-safe.
 */
import { suffixedAssetName } from "../assets";
import { sha256Hex } from "../canonical";
import { isBlockFileName } from "../keys";
import {
  type CommitAttempt,
  type CommitResult,
  type ContentStorage,
  type StorageDescription,
  StorageInvalidFileError,
  StorageNotFoundError,
  type StorageSnapshot,
  type StoredFileBody,
  type StoredReceipt,
  type StoredSchema,
} from "../storage";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Everything a memory storage holds; JSON-serializable, so it survives a "restart". */
export interface MemoryStorageState {
  /** Saved-block files, by file name, with their content. */
  files: Record<string, string>;
  /** The content of `schema.gen.json`, or `null` without one. */
  schema: string | null;
  /** The content of `meta.gen.json`, the fallback schema, or `null`. */
  legacySchema?: string | null;
  secretsPublicKey: string | null;
  receipts: Record<string, StoredReceipt & { createdAt: number }>;
  assets: Record<string, string>;
  /** `false` simulates an app root with no `.deco` folder at all. */
  hasDecoFolder: boolean;
}

export interface MemoryStorageOptions {
  state?: Partial<MemoryStorageState>;
  /** Overrides parts of what `describe` reports. */
  description?: Partial<StorageDescription>;
  /** Clock for receipt retention (default `Date.now`). */
  now?: () => number;
  /** Runs after each file body is read; a test can change files here, mid-read. */
  afterRead?: (file: string, storage: MemoryStorage) => void | Promise<void>;
  /** Runs before each commit attempt's checks; a test can change files here. */
  beforeCommit?: (
    attempt: CommitAttempt,
    storage: MemoryStorage,
  ) => void | Promise<void>;
}

export interface MemoryStorage extends ContentStorage {
  /** A deep copy of the current state. */
  dump(): MemoryStorageState;
  /** Writes or deletes (`null`) a file directly, as an outside edit would. */
  setFile(file: string, content: string | null): void;
  /** Replaces `schema.gen.json` (`null` removes it). */
  setSchema(schema: string | object | null): void;
  /** How many commits landed. */
  readonly commits: number;
}

const version = (content: string) => sha256Hex(content);

export function createMemoryStorage(
  options: MemoryStorageOptions = {},
): MemoryStorage {
  const now = options.now ?? Date.now;
  const state: MemoryStorageState = structuredClone({
    files: {},
    schema: null,
    legacySchema: null,
    secretsPublicKey: null,
    receipts: {},
    assets: {},
    hasDecoFolder: true,
    ...options.state,
  });
  const description: StorageDescription = {
    kind: "git",
    root: ".",
    readOnly: false,
    refs: null,
    assets: { dir: "public/assets", maxBytes: 25 * 1024 * 1024 },
    idempotency: { retentionMs: DAY_MS },
    ...options.description,
  };
  let commits = 0;

  async function currentVersions(): Promise<Map<string, string>> {
    const entries = await Promise.all(
      Object.entries(state.files).map(
        async ([file, content]) => [file, await version(content)] as const,
      ),
    );
    return new Map(entries);
  }

  async function schemaVersion(): Promise<string | null> {
    const text = state.schema ?? state.legacySchema ?? null;
    return text === null ? null : version(text);
  }

  async function revisionOf(versions: Map<string, string>): Promise<string> {
    const listing = [...versions].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return sha256Hex(listing.map(([file, v]) => `${file}\0${v}`).join("\n"));
  }

  let commitQueue: Promise<unknown> = Promise.resolve();

  async function commitNow(attempt: CommitAttempt): Promise<CommitResult> {
    await options.beforeCommit?.(attempt, storage);
    for (const file of [
      ...Object.keys(attempt.put),
      ...attempt.delete,
      ...Object.keys(attempt.expected),
    ]) {
      if (!isBlockFileName(file)) throw new StorageInvalidFileError(file);
    }
    if (!state.hasDecoFolder) throw new StorageNotFoundError("no .deco folder");
    if (attempt.receipt && state.receipts[attempt.receipt.key])
      return { status: "stale" };
    if (
      attempt.expectedSchemaVersion !== undefined &&
      (await schemaVersion()) !== attempt.expectedSchemaVersion
    ) {
      return { status: "stale" };
    }
    const versions = await currentVersions();
    for (const [file, expected] of Object.entries(attempt.expected)) {
      if ((versions.get(file) ?? null) !== expected) return { status: "stale" };
    }
    // Validate everything before mutating, so the commit is all or nothing.
    const written: Record<string, string> = {};
    for (const [file, content] of Object.entries(attempt.put))
      written[file] = await version(content);
    for (const file of attempt.delete) delete state.files[file];
    for (const [file, content] of Object.entries(attempt.put))
      state.files[file] = content;
    for (const [file, v] of Object.entries(written)) versions.set(file, v);
    for (const file of attempt.delete)
      if (!(file in attempt.put)) versions.delete(file);
    const revision = await revisionOf(versions);
    if (attempt.receipt) {
      state.receipts[attempt.receipt.key] = {
        digest: attempt.receipt.digest,
        revision,
        versions: written,
        deleted: [...attempt.delete],
        createdAt: now(),
      };
    }
    commits++;
    return { status: "committed", revision, versions: written };
  }

  const storage: MemoryStorage = {
    get commits() {
      return commits;
    },

    describe: () => description,

    async snapshot(): Promise<StorageSnapshot> {
      if (!state.hasDecoFolder)
        throw new StorageNotFoundError("no .deco folder");
      const versions = await currentVersions();
      return {
        revision: await revisionOf(versions),
        resolvedRef: null,
        files: [...versions].map(([file, v]) => ({
          file,
          version: v,
          size: new TextEncoder().encode(state.files[file]).byteLength,
        })),
      };
    },

    async readFiles(_snapshot, files) {
      const out: Record<string, StoredFileBody> = Object.create(null);
      for (const file of files) {
        if (!(file in state.files)) continue;
        const text = state.files[file];
        out[file] = { text, version: await version(text) };
        await options.afterRead?.(file, storage);
      }
      return out;
    },

    async readSchema(): Promise<StoredSchema | null> {
      if (!state.hasDecoFolder) return null;
      const text = state.schema ?? state.legacySchema ?? null;
      if (text === null) return null;
      return { version: await version(text), text, resolvedRef: null };
    },

    async readSecretsPublicKey() {
      return state.secretsPublicKey;
    },

    commit(attempt): Promise<CommitResult> {
      // Serialized, so a commit's checks and its mutation are one atomic step.
      const run = commitQueue.then(() => commitNow(attempt));
      commitQueue = run.catch(() => {});
      return run;
    },

    async getReceipt(key) {
      const receipt = state.receipts[key];
      if (!receipt) return null;
      if (
        description.idempotency &&
        now() - receipt.createdAt > description.idempotency.retentionMs
      ) {
        delete state.receipts[key];
        return null;
      }
      const { createdAt: _createdAt, ...stored } = receipt;
      return stored;
    },

    async putAsset(name, body) {
      let candidate = name;
      while (candidate in state.assets) candidate = suffixedAssetName(name);
      state.assets[candidate] = Array.from(body, (b) =>
        String.fromCharCode(b),
      ).join("");
      return { name: candidate };
    },

    dump: () => structuredClone(state),

    setFile(file, content) {
      if (content === null) delete state.files[file];
      else state.files[file] = content;
    },

    setSchema(schema) {
      state.schema =
        schema === null || typeof schema === "string"
          ? schema
          : JSON.stringify(schema);
    },
  };
  return storage;
}
