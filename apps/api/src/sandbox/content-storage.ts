/**
 * The content protocol over a sandbox's working tree, served by Studio.
 *
 * The sandbox daemon only does files and git: this storage reads and writes
 * `<app root>/.deco` through the daemon's existing authed file routes
 * (`/_sandbox/read`, `/_sandbox/write`, `/_sandbox/unlink`, and `/_sandbox/bash`
 * for one listing command), and the protocol itself runs here, in the same
 * core (`createContentHandler` from `@decocms/blocks/protocol/server`) that
 * serves GitHub mode (`api/routes/decofile.ts`). Every protocol behaviour
 * (validation, the file-name rule, the secret guard, limits, `ifMatch`
 * conflicts, retries) is the core's, so a sandbox answers exactly what GitHub
 * mode and a `deco serve` answer.
 *
 * Versions are git blob hashes of the working-tree bytes, as a `deco serve`
 * reports them. The working tree has uncommitted changes, so nothing here can
 * read "at a commit": a listing hashes every block file in the sandbox
 * (`git hash-object`, one daemon call), and only bodies whose hash the
 * protocol core hasn't cached are read, in parallel. The daemon has no stat
 * route; hashing in the pod is exact where mtime and size could miss an edit.
 *
 * Writes (`commit`) are ordered single-file writes through the daemon, each
 * under the daemon's tree lock, preceded by a fresh listing that checks every
 * expected version (and the schema's), so a stale attempt is refused and the
 * protocol answers its usual Conflict / retry. A failed write rolls back the
 * files already written. Commits are serialized per sandbox in this process;
 * a write by someone else between the check and the write (the agent, another
 * API pod) is the one window left, the same as on the daemon's own fs routes.
 */

import { createHash } from "node:crypto";
import {
  type CommitResult,
  type ContentStorage,
  StorageInvalidFileError,
  StorageNotFoundError,
  type StorageSnapshot,
  StorageUnavailableError,
  type StoredFileBody,
  type StoredSchema,
  isBlockFileName,
} from "@decocms/blocks/protocol";
import { createContentHandler } from "@decocms/blocks/protocol/server";

/** One authed POST to the sandbox daemon (`/_sandbox/...`), JSON in and out. */
export type SandboxDaemonCall = (
  path: string,
  body: unknown,
) => Promise<Response>;

interface SandboxContentStorageOptions {
  daemon: SandboxDaemonCall;
  /** The app root inside the repository (`metadata.runtime.path`); null at the root. */
  packagePath: string | null;
}

/** The files `.deco` holds besides the blocks, in the order the schema is read. */
const SCHEMA_FILES = ["schema.gen.json", "meta.gen.json"] as const;
const SECRETS_FILE = "secrets.pub";

/**
 * How long a listing answers other reads: the schema and snapshot reads of one
 * request (a poll batches both). An edit beside the editor shows on a later poll.
 */
const SCAN_REUSE_MS = 250;
/** Bodies read from the daemon at once. */
const READ_CONCURRENCY = 8;
/** A listing that raced a delete is taken again this many times. */
const SCAN_ATTEMPTS = 3;

interface Scan {
  at: number;
  /** `.deco/schema.gen.json`, `meta.gen.json`, `secrets.pub` → blob hash. */
  meta: Map<string, string>;
  /** `.deco/blocks/<file>` → blob hash, sorted by file. */
  blocks: Map<string, string>;
}

/** The git blob hash of `text`, as `git hash-object` prints it. */
function gitBlobHash(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

/** A revision of a set of files: SHA-256 over the sorted `file\0version` listing. */
function revisionOf(files: Iterable<[string, string]>): string {
  const listing = [...files]
    .map(([file, version]) => `${file}\0${version}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(listing).digest("hex");
}

/** A single-quoted shell word. */
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** The app root, checked: relative, inside the repository. */
function appRoot(packagePath: string | null): string {
  const root = (packagePath ?? "").replace(/^\/+|\/+$/g, "");
  if (root.split("/").some((segment) => segment === ".." || segment === ".")) {
    throw new StorageUnavailableError(`invalid app root: ${packagePath}`);
  }
  return root;
}

/**
 * One listing of `.deco`: `@none` without a `.deco` folder; else a `@meta`
 * line per schema/secrets file, then every block file and, in the same order,
 * its blob hash. A name with a control character is left out (a block file
 * the protocol writes never has one: `encodeURIComponent` escapes them).
 */
function scanCommand(root: string): string {
  return [
    `cd -- ${shellQuote(root || ".")} 2>/dev/null && [ -d .deco ] || { echo '@none'; exit 0; }`,
    "cd .deco",
    `for f in ${[...SCHEMA_FILES, SECRETS_FILE].join(" ")}; do`,
    `  if [ -f "$f" ]; then h=$(git hash-object --no-filters -- "$f") || exit 3; echo "@meta $f $h"; fi`,
    "done",
    "[ -d blocks ] || exit 0",
    "cd blocks",
    "names=$(find . -maxdepth 1 -type f -name '*.json' ! -name '*[[:cntrl:]]*' | sed 's|^\\./||' | LC_ALL=C sort)",
    `[ -n "$names" ] || exit 0`,
    `echo '@files'; printf '%s\\n' "$names"`,
    // Absolute paths: inside a repository git reads stdin paths from its top.
    `echo '@hashes'; printf '%s\\n' "$names" | while IFS= read -r n; do printf '%s/%s\\n' "$PWD" "$n"; done | git hash-object --no-filters --stdin-paths || exit 3`,
  ].join("\n");
}

/** Parses `scanCommand`'s output; null when there is no `.deco` folder. */
export function parseScan(stdout: string): Omit<Scan, "at"> | null {
  const lines = stdout.split("\n");
  if (lines[0] === "@none") return null;
  const meta = new Map<string, string>();
  const files: string[] = [];
  const hashes: string[] = [];
  let section: "meta" | "files" | "hashes" = "meta";
  for (const line of lines) {
    if (line === "@files") section = "files";
    else if (line === "@hashes") section = "hashes";
    else if (section === "meta" && line.startsWith("@meta ")) {
      const [, name, hash] = line.split(" ");
      if (name && hash) meta.set(name, hash);
    } else if (section === "files" && line) files.push(line);
    else if (section === "hashes" && line) hashes.push(line);
  }
  if (files.length !== hashes.length) {
    throw new StorageUnavailableError("the sandbox listing was cut short");
  }
  const blocks = new Map<string, string>();
  files.forEach((file, i) => {
    if (isBlockFileName(file)) blocks.set(file, hashes[i]!);
  });
  return { meta, blocks };
}

/**
 * The text of a `/_sandbox/read` answer: the route numbers every line
 * (`<n>\t<line>`), so each line loses exactly its own prefix.
 */
export function stripLineNumbers(content: string): string {
  return content
    .split("\n")
    .map((line) => line.slice(line.indexOf("\t") + 1))
    .join("\n");
}

function assertBlockFile(file: string) {
  if (!isBlockFileName(file)) throw new StorageInvalidFileError(file);
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

type SandboxContentStorage = ContentStorage & {
  /** Points the storage at this request's daemon transport. */
  useDaemon(daemon: SandboxDaemonCall): void;
};

function createSandboxContentStorage(
  options: SandboxContentStorageOptions,
): SandboxContentStorage {
  let daemon = options.daemon;
  const root = appRoot(options.packagePath);
  const repoPath = (file: string) =>
    root ? `${root}/.deco/${file}` : `.deco/${file}`;

  const call = async (path: string, body: unknown): Promise<Response> => {
    try {
      return await daemon(path, body);
    } catch (error) {
      throw new StorageUnavailableError(
        `the sandbox is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const failed = async (route: string, res: Response): Promise<never> => {
    const text = await res.text().catch(() => "");
    throw new StorageUnavailableError(
      `sandbox ${route} answered ${res.status}: ${text.slice(0, 200)}`,
      res.status === 429 ? 1000 : undefined,
    );
  };

  /** A file's text, or null when it doesn't exist. */
  const readText = async (path: string): Promise<string | null> => {
    const res = await call("/_sandbox/read", { path, full: true });
    if (res.status === 400) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (body?.error?.startsWith("File not found")) return null;
      throw new StorageUnavailableError(
        `sandbox read refused ${path}: ${body?.error ?? "400"}`,
      );
    }
    if (!res.ok) return failed("read", res);
    const body = (await res.json()) as { kind?: string; content?: string };
    if (body.kind !== "text" || typeof body.content !== "string") {
      throw new StorageUnavailableError(`${path} is not a text file`);
    }
    return stripLineNumbers(body.content);
  };

  const writeText = async (path: string, content: string) => {
    const res = await call("/_sandbox/write", { path, content });
    if (!res.ok) await failed("write", res);
    await res.body?.cancel();
  };

  const unlink = async (path: string) => {
    const res = await call("/_sandbox/unlink", { path });
    if (!res.ok) await failed("unlink", res);
    await res.body?.cancel();
  };

  const takeScan = async (): Promise<Scan> => {
    for (let attempt = 1; ; attempt++) {
      const res = await call("/_sandbox/bash", {
        command: scanCommand(root),
        timeout: 20_000,
      });
      if (!res.ok) await failed("bash", res);
      const out = (await res.json()) as {
        stdout?: string;
        stderr?: string;
        exitCode?: number;
      };
      // A file deleted between `find` and `git hash-object`: list again.
      if (out.exitCode !== 0) {
        if (attempt < SCAN_ATTEMPTS) continue;
        throw new StorageUnavailableError(
          `the sandbox's .deco folder could not be listed: ${(out.stderr ?? "").slice(0, 300)}`,
          250,
        );
      }
      const parsed = parseScan(out.stdout ?? "");
      if (!parsed) {
        throw new StorageNotFoundError(
          `no .deco folder in ${root || "the repository root"}`,
        );
      }
      return { ...parsed, at: Date.now() };
    }
  };

  let lastScan: Scan | null = null;
  let pendingScan: Promise<Scan> | null = null;
  /** Bumped by every write: a listing taken before it is never reused. */
  let generation = 0;

  /** A listing shared by concurrent reads, reused for `SCAN_REUSE_MS`. */
  const scan = (): Promise<Scan> => {
    if (lastScan && Date.now() - lastScan.at < SCAN_REUSE_MS) {
      return Promise.resolve(lastScan);
    }
    if (!pendingScan) {
      const startedAt = generation;
      const pending = takeScan()
        .then((taken) => {
          if (generation === startedAt) lastScan = taken;
          return taken;
        })
        .finally(() => {
          if (pendingScan === pending) pendingScan = null;
        });
      pendingScan = pending;
    }
    return pendingScan;
  };

  const invalidate = () => {
    generation++;
    lastScan = null;
    pendingScan = null;
  };

  /** `.deco/<name>` bodies by blob hash (the schema and the public key). */
  const metaBodies = new Map<string, { version: string; text: string }>();
  const readMeta = async (
    name: string,
  ): Promise<{ version: string; text: string } | null> => {
    let listing: Scan;
    try {
      listing = await scan();
    } catch (error) {
      // No `.deco` folder: no schema and no key, as a `deco serve` answers.
      if (error instanceof StorageNotFoundError) return null;
      throw error;
    }
    const version = listing.meta.get(name);
    if (!version) return null;
    const cached = metaBodies.get(name);
    if (cached?.version === version) return cached;
    const text = await readText(repoPath(name));
    if (text === null) return null;
    const read = { version: gitBlobHash(text), text };
    metaBodies.set(name, read);
    return read;
  };

  let commitQueue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = commitQueue.catch(() => {}).then(fn);
    commitQueue = run.catch(() => {});
    return run;
  };

  return {
    useDaemon(next) {
      daemon = next;
    },

    describe: () => ({
      kind: "working-tree",
      root: root || ".",
      readOnly: false,
      // Project assets go to Studio's file storage, not into the sandbox.
      assets: null,
    }),

    async snapshot(): Promise<StorageSnapshot> {
      const { blocks } = await scan();
      return {
        revision: revisionOf(blocks),
        resolvedRef: null,
        files: [...blocks].map(([file, version]) => ({ file, version })),
      };
    },

    async readFiles(_snapshot, files) {
      files.forEach(assertBlockFile);
      // A working tree has no past snapshots: current bytes, with their version.
      const out: Record<string, StoredFileBody> = Object.create(null);
      await mapLimit(files, READ_CONCURRENCY, async (file) => {
        const text = await readText(repoPath(`blocks/${file}`));
        if (text !== null) out[file] = { text, version: gitBlobHash(text) };
      });
      return out;
    },

    async readSchema(): Promise<StoredSchema | null> {
      for (const name of SCHEMA_FILES) {
        const read = await readMeta(name);
        if (read) return { ...read, resolvedRef: null };
      }
      return null;
    },

    async readSecretsPublicKey() {
      return (await readMeta(SECRETS_FILE))?.text ?? null;
    },

    commit(attempt): Promise<CommitResult> {
      for (const file of [
        ...Object.keys(attempt.put),
        ...attempt.delete,
        ...Object.keys(attempt.expected),
      ]) {
        assertBlockFile(file);
      }
      return serialized(async () => {
        invalidate();
        const current = await takeScan();
        const stale = { status: "stale" } as const;
        if (attempt.expectedSchemaVersion !== undefined) {
          const schema =
            current.meta.get(SCHEMA_FILES[0]) ??
            current.meta.get(SCHEMA_FILES[1]) ??
            null;
          if (schema !== attempt.expectedSchemaVersion) return stale;
        }
        for (const [file, expected] of Object.entries(attempt.expected)) {
          if ((current.blocks.get(file) ?? null) !== expected) return stale;
        }

        // In file order: writes, then deletes of files that exist.
        const puts = Object.keys(attempt.put).sort();
        const deletes = attempt.delete
          .filter((file) => current.blocks.has(file) && !(file in attempt.put))
          .sort();
        // What each touched file held, to put it back if a later step fails.
        const touched = [...puts, ...deletes].filter((f) =>
          current.blocks.has(f),
        );
        const before = new Map<string, string>();
        await mapLimit(touched, READ_CONCURRENCY, async (file) => {
          const text = await readText(repoPath(`blocks/${file}`));
          if (text !== null && gitBlobHash(text) === current.blocks.get(file)) {
            before.set(file, text);
          }
        });
        // A file changed since the listing: the attempt is stale.
        if (before.size !== touched.length) return stale;

        const done: string[] = [];
        try {
          for (const file of puts) {
            await writeText(repoPath(`blocks/${file}`), attempt.put[file]!);
            done.push(file);
          }
          for (const file of deletes) {
            await unlink(repoPath(`blocks/${file}`));
            done.push(file);
          }
        } catch (error) {
          for (const file of done.reverse()) {
            const prior = before.get(file);
            await (prior === undefined
              ? unlink(repoPath(`blocks/${file}`))
              : writeText(repoPath(`blocks/${file}`), prior)
            ).catch((rollbackError) =>
              console.error("sandbox content: rollback failed", {
                file,
                error:
                  rollbackError instanceof Error
                    ? rollbackError.message
                    : String(rollbackError),
              }),
            );
          }
          throw error;
        } finally {
          invalidate();
        }

        const versions: Record<string, string> = {};
        const after = new Map(current.blocks);
        for (const file of puts) {
          versions[file] = gitBlobHash(attempt.put[file]!);
          after.set(file, versions[file]);
        }
        for (const file of deletes) after.delete(file);
        return { status: "committed", revision: revisionOf(after), versions };
      });
    },
  };
}

/** The protocol's server identity for sandbox sessions. */
export const SANDBOX_CONTENT_SERVER = { name: "studio-sandbox", version: "1" };

/**
 * Bodies the protocol core keeps per sandbox (by version), so a change reads
 * only the files that changed.
 */
const BODY_CACHE_BYTES = 8 * 1024 * 1024;
/** Sandboxes whose handler (storage, listing and body cache) stays warm. */
const MAX_WARM_SANDBOXES = 16;

type Handler = ReturnType<typeof createContentHandler>;
const warm = new Map<
  string,
  { handler: Handler; storage: SandboxContentStorage }
>();

/**
 * The content-protocol handler for one sandbox (`key`: its claim) at one app
 * root. Kept warm across requests (least recently used first out), so the
 * core's body cache spans a session's polls.
 */
export function sandboxContentHandler(params: {
  key: string;
  packagePath: string | null;
  daemon: SandboxDaemonCall;
  onError?: (error: unknown) => void;
}): Handler {
  const key = `${params.key}\0${params.packagePath ?? ""}`;
  let entry = warm.get(key);
  if (entry) {
    warm.delete(key);
  } else {
    const storage = createSandboxContentStorage(params);
    entry = {
      storage,
      handler: createContentHandler(storage, {
        server: SANDBOX_CONTENT_SERVER,
        bodyCacheBytes: BODY_CACHE_BYTES,
        ...(params.onError ? { onError: params.onError } : {}),
      }),
    };
  }
  entry.storage.useDaemon(params.daemon);
  warm.set(key, entry);
  for (const oldest of warm.keys()) {
    if (warm.size <= MAX_WARM_SANDBOXES) break;
    warm.delete(oldest);
  }
  return entry.handler;
}
