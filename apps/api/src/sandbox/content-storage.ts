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
 * read "at a commit": a listing (one `/_sandbox/bash` command, see
 * `scanCommand`) takes each file's hash from git's index when git's own
 * path + mtime + size check says it is unchanged, and hashes the rest, and
 * only bodies whose hash the protocol core hasn't cached are read, in
 * parallel. The listing goes through a file, not stdout, so its size has no
 * limit and a cut one is refused.
 *
 * Writes (`commit`) are ordered single-file writes through the daemon, each
 * under the daemon's tree lock, preceded by a fresh listing that checks every
 * expected version (and the schema's), so a stale attempt is refused and the
 * protocol answers its usual Conflict / retry. A failed write rolls back every
 * file it touched, the one in flight included. Commits are serialized per
 * sandbox in this process; a write by someone else between the check and the
 * write (the agent, another API pod) is the one window left, the same as on
 * the daemon's own fs routes.
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

/** The prefix of the folders listings are written to, in the sandbox's tmp. */
const SCAN_DIR_PREFIX = "studio-deco-scan.";

/**
 * One listing of `.deco`, written to a file in the sandbox's tmp, never to
 * stdout: the daemon keeps only the tail of a task's output, and a big site's
 * listing can outgrow it. Stdout is one line: `@none` without a `.deco`
 * folder, else `@file <absolute path>`, read back through `/_sandbox/read`.
 *
 * The file has one `<blob hash> <path under .deco>` line per schema/secrets
 * file and per block file (`blocks/<name>`), then `@end`, so a cut listing
 * is never taken for a short one and a hash never pairs with another file.
 *
 * Hashes come from git's index where git says the file is unchanged
 * (`git diff-files`, git's own path + mtime + size check, with its racy-entry
 * content check), and from `git hash-object` for the rest: changed,
 * untracked, or every file outside a repository or under a checkout filter.
 * A name with a control character is left out (a block file the protocol
 * writes never has one: `encodeURIComponent` escapes them).
 *
 * `previous` is the folder of this storage's last listing, removed here so
 * reading it back needs no second command; folders other listings left
 * behind (a pod that went away) go after a few minutes.
 */
function scanCommand(root: string, previous: string | null): string {
  const files = [...SCHEMA_FILES, SECRETS_FILE].join(" ");
  return [
    "export LC_ALL=C",
    `d=\${TMPDIR:-/tmp}`,
    ...(previous ? [`rm -rf -- ${shellQuote(previous)}`] : []),
    `find "$d" -maxdepth 1 -name '${SCAN_DIR_PREFIX}*' -mmin +5 -exec rm -rf -- {} + 2>/dev/null`,
    `cd -- ${shellQuote(root || ".")} 2>/dev/null && [ -d .deco ] || { echo '@none'; exit 0; }`,
    "cd .deco",
    `w=$(mktemp -d "$d/${SCAN_DIR_PREFIX}XXXXXX") || exit 3`,
    "T=$(printf '\\t')",
    // Every file to version, by path under .deco.
    `{ for f in ${files}; do [ -f "$f" ] && printf '%s\\n' "$f"; done`,
    "  [ -d blocks ] && find blocks -maxdepth 1 -type f -name '*.json' ! -name '*[[:cntrl:]]*'; } | sort > \"$w/c\"",
    // Index hashes of the files git sees unchanged since they were staged.
    ': > "$w/k"',
    "if git rev-parse --is-inside-work-tree >/dev/null 2>&1 \\",
    "  && ! git config --get core.autocrlf | grep -qiE '^(true|input)$' \\",
    "  && ! git check-attr --stdin filter eol working-tree-encoding < \"$w/c\" | grep -qv ': unspecified$'; then",
    '  git -c core.quotePath=false ls-files -s -- . | sed -n "s/^[0-7]* \\([0-9a-f]*\\) 0$T\\(.*\\)\\$/\\2$T\\1/p" | sort > "$w/i" || exit 3',
    '  git -c core.quotePath=false diff-files --name-only --relative -- . | sort > "$w/x" || exit 3',
    '  join -t "$T" -v1 "$w/i" "$w/x" > "$w/u" && join -t "$T" "$w/c" "$w/u" > "$w/k" || exit 3',
    "fi",
    // The rest, hashed now (absolute paths: inside a repository git reads
    // stdin paths from its top).
    'join -t "$T" -v1 "$w/c" "$w/k" > "$w/h" || exit 3',
    `while IFS= read -r n; do printf '%s/%s\\n' "$PWD" "$n"; done < "$w/h" | git hash-object --no-filters --stdin-paths > "$w/v" || exit 3`,
    '[ "$(wc -l < "$w/h")" = "$(wc -l < "$w/v")" ] || exit 3',
    '{ sed "s/^\\([^$T]*\\)$T\\(.*\\)$/\\2 \\1/" "$w/k"; paste -d " " "$w/v" "$w/h"; echo "@end"; } > "$w/out" || exit 3',
    'echo "@file $w/out"',
  ].join("\n");
}

/** Parses a listing file (see `scanCommand`); throws when it was cut short. */
export function parseScan(text: string): Omit<Scan, "at"> {
  const lines = text.split("\n");
  while (lines.at(-1) === "") lines.pop();
  if (lines.at(-1) !== "@end") {
    throw new StorageUnavailableError("the sandbox listing was cut short");
  }
  const meta = new Map<string, string>();
  const blocks = new Map<string, string>();
  const metaFiles = new Set<string>([...SCHEMA_FILES, SECRETS_FILE]);
  for (const line of lines.slice(0, -1)) {
    const space = line.indexOf(" ");
    const hash = line.slice(0, space);
    const path = line.slice(space + 1);
    if (space < 0 || !/^[0-9a-f]{40,64}$/.test(hash)) {
      throw new StorageUnavailableError("the sandbox listing is malformed");
    }
    if (metaFiles.has(path)) meta.set(path, hash);
    else if (path.startsWith("blocks/")) {
      const file = path.slice("blocks/".length);
      if (isBlockFileName(file)) blocks.set(file, hash);
    }
  }
  return {
    meta,
    blocks: new Map([...blocks].sort(([a], [b]) => (a < b ? -1 : 1))),
  };
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

  /** The folder of the last listing read back, removed by the next one. */
  let lastScanDir: string | null = null;

  const takeScan = async (): Promise<Scan> => {
    for (let attempt = 1; ; attempt++) {
      const res = await call("/_sandbox/bash", {
        command: scanCommand(root, lastScanDir),
        timeout: 20_000,
      });
      if (!res.ok) await failed("bash", res);
      const out = (await res.json()) as {
        stdout?: string;
        stderr?: string;
        exitCode?: number;
        truncated?: boolean;
      };
      // The daemon kept only the tail of the output: never parse a part.
      if (out.truncated === true) {
        throw new StorageUnavailableError(
          "the sandbox listing was cut short",
          250,
        );
      }
      const stdout = (out.stdout ?? "").trim();
      // A file deleted between `find` and `git hash-object`: list again.
      if (out.exitCode !== 0) {
        if (attempt < SCAN_ATTEMPTS) continue;
        throw new StorageUnavailableError(
          `the sandbox's .deco folder could not be listed: ${(out.stderr ?? "").slice(0, 300)}`,
          250,
        );
      }
      if (stdout === "@none") {
        throw new StorageNotFoundError(
          `no .deco folder in ${root || "the repository root"}`,
        );
      }
      const file = /^@file (\/.+\/out)$/.exec(stdout)?.[1];
      if (!file) {
        throw new StorageUnavailableError(
          `the sandbox listing answered: ${stdout.slice(0, 200)}`,
        );
      }
      const text = await readText(file);
      // Removed by a listing from another pod: list again.
      if (text === null) {
        if (attempt < SCAN_ATTEMPTS) continue;
        throw new StorageUnavailableError("the sandbox listing went away", 250);
      }
      lastScanDir = file.slice(0, -"/out".length);
      return { ...parseScan(text), at: Date.now() };
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
      const listed = lastScan;
      let moved = false;
      await mapLimit(files, READ_CONCURRENCY, async (file) => {
        const text = await readText(repoPath(`blocks/${file}`));
        if (text !== null) out[file] = { text, version: gitBlobHash(text) };
        if (
          (out[file]?.version ?? null) !== (listed?.blocks.get(file) ?? null)
        ) {
          moved = true;
        }
      });
      // A file changed since the listing (the agent wrote it in the last
      // SCAN_REUSE_MS): drop the reused listing, so the core's next snapshot
      // sees the change instead of the same stale versions until it gives up.
      if (moved) invalidate();
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

        // Each file counts as touched before its call: a call that timed out
        // or lost its connection may still have landed (the daemon finishes
        // it anyway), so the rollback puts that one back too. Putting back a
        // file the daemon never wrote is harmless: `before` holds its bytes.
        const attempted: string[] = [];
        try {
          for (const file of puts) {
            attempted.push(file);
            await writeText(repoPath(`blocks/${file}`), attempt.put[file]!);
          }
          for (const file of deletes) {
            attempted.push(file);
            await unlink(repoPath(`blocks/${file}`));
          }
        } catch (error) {
          for (const file of attempted.reverse()) {
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
