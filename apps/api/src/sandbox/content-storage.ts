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
 * The base (`changes.*`) is the repository's `HEAD`, as a `deco serve`'s is:
 * the same listing also reads `HEAD`'s commit, branch and block blob ids
 * (`git ls-tree`), and confirms with git's own filters (`git hash-object`)
 * the files whose bytes differ from `HEAD`, so a file that differs only by a
 * checkout conversion (`eol=crlf`) isn't a change. Base bodies are read with
 * `git cat-file --filters`, as a checkout writes them, carried as base64 so
 * a BOM or a CR survives. A discard also unstages the files it restores
 * (`git reset` / `git rm --cached`, both sides of a staged rename), as
 * `deco serve` 8.2.1 does, and puts the index back if a write fails.
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
  type StorageBase,
  type StorageChanges,
  type StorageFile,
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
/** Committed block bodies read back per call: by count, and by bytes (base64 grows them). */
const BASE_READ_CHUNK_FILES = 100;
const BASE_READ_CHUNK_BYTES = 4 * 1024 * 1024;

/** The repository's `HEAD`, as one listing saw it. */
interface ScanGit {
  /** `HEAD`'s commit, or `"unborn"` in a repository with no commits yet. */
  head: string;
  /** The current branch; `null` on a detached `HEAD`. */
  ref: string | null;
  /** `HEAD`'s `.deco/blocks/<file>` → its blob id and size. */
  base: Map<string, { version: string; size?: number }>;
  /** Files whose bytes differ from `HEAD`'s blob only by git's filters. */
  clean: Set<string>;
}

interface Scan {
  at: number;
  /** `.deco/schema.gen.json`, `meta.gen.json`, `secrets.pub` → blob hash. */
  meta: Map<string, string>;
  /** `.deco/blocks/<file>` → blob hash, sorted by file. */
  blocks: Map<string, string>;
  /** `null` outside a git work tree (or when git can't read `HEAD`). */
  git: ScanGit | null;
}

/** The base revision of a repository with no commits yet (an empty base). */
const UNBORN = "unborn";
const OBJECT_ID = /^[0-9a-f]{40,64}$/;

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

/** Whether `name` has a control character (listings leave those names out). */
const hasControlCharacter = (name: string) =>
  [...name].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

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
 * The base part of a listing (run in `.deco`, after the block hashes are in
 * `$w/l`), into `$w/g`: `@head <commit>|unborn|none` (`none`: not a git work
 * tree, or `HEAD` can't be read), `@ref <branch>` (empty when detached),
 * `@base <blob> <size> blocks/<file>` per block file in `HEAD` (regular files
 * only, no name with a control character), and `@clean blocks/<file>` for a
 * file whose raw bytes hash otherwise than its `HEAD` blob but which git's
 * filters store as that very blob (a CRLF checkout): not a change.
 */
const GIT_BASE_SCRIPT = String.raw`: > "$w/g"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  h=$(git rev-parse -q --verify 'HEAD^{commit}' 2>"$w/e") || { if [ -s "$w/e" ]; then h=none; else h=unborn; fi; }
  r=$(git symbolic-ref -q --short HEAD 2>/dev/null) || r=
  printf '@head %s\n@ref %s\n' "$h" "$r" >> "$w/g"
  if [ "$h" != none ] && [ "$h" != unborn ]; then
    git -c core.quotePath=false ls-tree -z --long "$h" -- blocks/ > "$w/t0" || exit 3
    tr '\n\000' '\001\n' < "$w/t0" | sed -n "s/^100[67][45][45] blob \([0-9a-f]*\) *\([0-9]*\)$T\(blocks\/[^/[:cntrl:]]*\)\$/\3$T\1$T\2/p" | sort > "$w/b" || exit 3
    sed "s/^\([^$T]*\)$T\([^$T]*\)$T\(.*\)\$/@base \2 \3 \1/" "$w/b" >> "$w/g" || exit 3
    sed -n "s/^\([0-9a-f]*\) \(blocks\/.*\)\$/\2$T\1/p" "$w/l" | sort > "$w/n" || exit 3
    join -t "$T" "$w/n" "$w/b" | while IFS="$T" read -r p x y z; do [ "$x" = "$y" ] || printf '%s\t%s\n' "$p" "$y"; done > "$w/d"
    if [ -s "$w/d" ]; then
      cut -f1 "$w/d" | while IFS= read -r n; do printf '%s/%s\n' "$PWD" "$n"; done | git hash-object --stdin-paths > "$w/f" || exit 3
      [ "$(wc -l < "$w/d")" = "$(wc -l < "$w/f")" ] || exit 3
      paste "$w/d" "$w/f" | while IFS="$T" read -r p y f; do [ "$y" != "$f" ] || printf '@clean %s\n' "$p"; done >> "$w/g"
    fi
  fi
else
  echo '@head none' >> "$w/g"
fi`;

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
function scanCommand(root: string, previous: readonly string[]): string {
  const files = [...SCHEMA_FILES, SECRETS_FILE].join(" ");
  return [
    "export LC_ALL=C",
    `d=\${TMPDIR:-/tmp}`,
    ...(previous.length > 0
      ? [`rm -rf -- ${previous.map(shellQuote).join(" ")}`]
      : []),
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
    '{ sed "s/^\\([^$T]*\\)$T\\(.*\\)$/\\2 \\1/" "$w/k"; paste -d " " "$w/v" "$w/h"; } > "$w/l" || exit 3',
    GIT_BASE_SCRIPT,
    '{ cat "$w/l" "$w/g"; echo "@end"; } > "$w/out" || exit 3',
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
  let git: ScanGit | null = null;
  const malformed = () =>
    new StorageUnavailableError("the sandbox listing is malformed");
  const blockOf = (path: string) => {
    const file = path.startsWith("blocks/") ? path.slice("blocks/".length) : "";
    return isBlockFileName(file) ? file : null;
  };
  for (const line of lines.slice(0, -1)) {
    if (line.startsWith("@")) {
      const space = line.indexOf(" ");
      const tag = space < 0 ? line : line.slice(0, space);
      const rest = space < 0 ? "" : line.slice(space + 1);
      if (tag === "@head") {
        if (rest === "none") continue;
        if (rest !== UNBORN && !OBJECT_ID.test(rest)) throw malformed();
        git = { head: rest, ref: null, base: new Map(), clean: new Set() };
      } else if (tag === "@ref") {
        if (git) git.ref = rest || null;
      } else if (tag === "@base") {
        const match = /^([0-9a-f]{40,64}) (\d*) (.+)$/.exec(rest);
        if (!match || !git) throw malformed();
        const file = blockOf(match[3]!);
        if (file === null) continue;
        const size = Number(match[2]);
        git.base.set(
          file,
          match[2] && Number.isFinite(size)
            ? { version: match[1]!, size }
            : { version: match[1]! },
        );
      } else if (tag === "@clean") {
        const file = blockOf(rest);
        if (file !== null && git) git.clean.add(file);
      } else throw malformed();
      continue;
    }
    const space = line.indexOf(" ");
    const hash = line.slice(0, space);
    const path = line.slice(space + 1);
    if (space < 0 || !OBJECT_ID.test(hash)) throw malformed();
    if (metaFiles.has(path)) meta.set(path, hash);
    else if (path.startsWith("blocks/")) {
      const file = path.slice("blocks/".length);
      if (isBlockFileName(file)) blocks.set(file, hash);
    }
  }
  return {
    meta,
    blocks: new Map([...blocks].sort(([a], [b]) => (a < b ? -1 : 1))),
    git,
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

export function createSandboxContentStorage(
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

  /**
   * Folders in the sandbox's tmp this storage is done with (the last
   * listing's, base bodies read, a discard's saved index), removed by the
   * next listing.
   */
  const doneDirs: string[] = [];

  /** Runs one script through `/_sandbox/bash`; its trimmed stdout, or throws. */
  const runScript = async (command: string, what: string): Promise<string> => {
    const res = await call("/_sandbox/bash", { command, timeout: 20_000 });
    if (!res.ok) await failed("bash", res);
    const out = (await res.json()) as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      truncated?: boolean;
    };
    if (out.truncated === true) {
      throw new StorageUnavailableError(`${what} was cut short`, 250);
    }
    if (out.exitCode !== 0) {
      throw new StorageUnavailableError(
        `${what} failed: ${(out.stderr ?? "").slice(0, 300)}`,
        250,
      );
    }
    return (out.stdout ?? "").trim();
  };

  /** `cd` to the repository top, with `$p` = the app root's path in it. */
  const toRepoTop = [
    `cd -- ${shellQuote(root || ".")} || exit 3`,
    "p=$(git rev-parse --show-prefix) && top=$(git rev-parse --show-toplevel) || exit 3",
    'cd -- "$top" || exit 3',
  ];

  const takeScan = async (): Promise<Scan> => {
    for (let attempt = 1; ; attempt++) {
      const res = await call("/_sandbox/bash", {
        command: scanCommand(root, doneDirs.splice(0)),
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
      doneDirs.push(file.slice(0, -"/out".length));
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

  /** The listing's git side; throws when the site isn't in a repository. */
  const gitOf = (listing: Scan): ScanGit => {
    if (!listing.git) {
      throw new StorageUnavailableError(
        "the sandbox's site isn't in a git repository",
      );
    }
    return listing.git;
  };

  /** A listing whose `HEAD` is `base`, or null when `HEAD` moved since. */
  const scanAt = async (
    base: StorageBase,
  ): Promise<{ listing: Scan; git: ScanGit } | null> => {
    let listing = await scan();
    if (gitOf(listing).head !== base.revision) {
      invalidate();
      listing = await scan();
    }
    const git = gitOf(listing);
    return git.head === base.revision ? { listing, git } : null;
  };

  /**
   * Base bodies, exactly as a checkout writes them (`cat-file --filters`),
   * carried as base64 through a file in the sandbox's tmp.
   */
  const readBaseChunk = async (
    blobs: Array<[file: string, blob: string]>,
  ): Promise<Map<string, string>> => {
    const args = blobs.flatMap(([file, blob]) => [blob, file]).map(shellQuote);
    const stdout = await runScript(
      [
        "export LC_ALL=C GIT_OPTIONAL_LOCKS=0",
        `d=\${TMPDIR:-/tmp}`,
        ...toRepoTop,
        `w=$(mktemp -d "$d/${SCAN_DIR_PREFIX}XXXXXX") || exit 3`,
        ': > "$w/out"',
        `set -- ${args.join(" ")}`,
        "while [ $# -gt 0 ]; do",
        '  git cat-file --filters --path="$p.deco/blocks/$2" "$1" > "$w/o" || exit 3',
        `  printf '%s\\t%s\\n' "$2" "$(base64 < "$w/o" | tr -d '\\n')" >> "$w/out"`,
        "  shift 2",
        "done",
        'echo "@end" >> "$w/out"',
        'echo "@file $w/out"',
      ].join("\n"),
      "reading the sandbox's committed blocks",
    );
    const file = /^@file (\/.+\/out)$/.exec(stdout)?.[1];
    if (!file) {
      throw new StorageUnavailableError(
        `reading committed blocks answered: ${stdout.slice(0, 200)}`,
      );
    }
    const text = await readText(file);
    doneDirs.push(file.slice(0, -"/out".length));
    const lines = (text ?? "").split("\n");
    while (lines.at(-1) === "") lines.pop();
    if (lines.pop() !== "@end") {
      throw new StorageUnavailableError(
        "reading committed blocks was cut short",
      );
    }
    const out = new Map<string, string>();
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    for (const line of lines) {
      const tab = line.indexOf("\t");
      out.set(
        line.slice(0, tab),
        decoder.decode(Buffer.from(line.slice(tab + 1), "base64")),
      );
    }
    return out;
  };

  /**
   * Brings the index entries of these block files (plus both sides of a
   * staged rename involving one) back to `HEAD`: `git reset` for paths `HEAD`
   * has, `git rm --cached` for the rest, as `deco serve` does on a discard.
   * Resolves with an undo that puts the previous entries back, and `done`
   * once the undo can't be needed.
   */
  const unstage = async (
    files: string[],
  ): Promise<{ undo: () => Promise<void>; done: () => void }> => {
    const names = files.map((f) => shellQuote(f)).join(" ");
    const stdout = await runScript(
      [
        "export LC_ALL=C GIT_OPTIONAL_LOCKS=0 GIT_LITERAL_PATHSPECS=1",
        `d=\${TMPDIR:-/tmp}`,
        ...toRepoTop,
        `w=$(mktemp -d "$d/${SCAN_DIR_PREFIX}XXXXXX") || exit 3`,
        `for f in ${names}; do printf '%s.deco/blocks/%s\\n' "$p" "$f"; done | sort -u > "$w/p"`,
        ': > "$w/t"',
        "if git rev-parse -q --verify 'HEAD^{commit}' >/dev/null; then",
        '  git diff-index --cached -z --name-status -M --no-ext-diff HEAD > "$w/r0" || exit 3',
        `  tr '\\n\\000' '\\001\\n' < "$w/r0" > "$w/r"`,
        "  while IFS= read -r s; do",
        '    case "$s" in',
        "      R*) IFS= read -r a; IFS= read -r b",
        `          if grep -qxF -e "$a" -e "$b" "$w/p"; then printf '%s\\n%s\\n' "$a" "$b"; fi ;;`,
        "      C*) IFS= read -r a; IFS= read -r b ;;",
        "      *) IFS= read -r a ;;",
        "    esac",
        '  done < "$w/r" > "$w/q"',
        '  sort -u "$w/p" "$w/q" -o "$w/p" || exit 3',
        `  tr '\\n' '\\000' < "$w/p" | xargs -0 git ls-tree -z --name-only --full-name HEAD -- > "$w/t0" || exit 3`,
        `  tr '\\000' '\\n' < "$w/t0" | sort -u > "$w/t" || exit 3`,
        "fi",
        `tr '\\n' '\\000' < "$w/p" | xargs -0 git ls-files -s -z --full-name -- > "$w/idx" || exit 3`,
        'comm -23 "$w/p" "$w/t" > "$w/u" || exit 3',
        `if [ -s "$w/t" ]; then tr '\\n' '\\000' < "$w/t" | xargs -0 git reset -q HEAD -- || exit 3; fi`,
        `if [ -s "$w/u" ]; then tr '\\n' '\\000' < "$w/u" | xargs -0 git rm --cached -f --quiet --ignore-unmatch -- || exit 3; fi`,
        'echo "@dir $w"',
      ].join("\n"),
      "unstaging the discarded blocks",
    );
    const dir = /^@dir (\/.+)$/.exec(stdout)?.[1];
    if (!dir) {
      throw new StorageUnavailableError(
        `unstaging answered: ${stdout.slice(0, 200)}`,
      );
    }
    const done = () => {
      doneDirs.push(dir);
    };
    const undo = async () => {
      try {
        await runScript(
          [
            "export LC_ALL=C GIT_LITERAL_PATHSPECS=1",
            ...toRepoTop,
            `w=${shellQuote(dir)}`,
            `tr '\\n' '\\000' < "$w/p" | xargs -0 git update-index --force-remove -- || exit 3`,
            'if [ -s "$w/idx" ]; then git update-index -z --index-info < "$w/idx" || exit 3; fi',
          ].join("\n"),
          "restoring the sandbox's staged blocks",
        );
      } finally {
        done();
      }
    };
    return { undo, done };
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

    async base(): Promise<StorageBase> {
      const git = gitOf(await scan());
      return { revision: git.head, resolvedRef: git.ref };
    },

    async changes(base, snap): Promise<StorageChanges> {
      const at = await scanAt(base);
      if (!at) {
        throw new StorageUnavailableError("the sandbox's commit moved", 250);
      }
      const now = at.git.base;
      const listed = at.listing.blocks;
      const files: string[] = [];
      for (const { file, version } of snap.files) {
        const inBase = now.get(file)?.version;
        if (inBase === version) continue;
        // Differs from HEAD's blob only by git's filters, for these very bytes.
        if (
          inBase !== undefined &&
          at.git.clean.has(file) &&
          listed.get(file) === version
        ) {
          continue;
        }
        files.push(file);
      }
      const present = new Set(snap.files.map((f) => f.file));
      for (const file of now.keys()) if (!present.has(file)) files.push(file);
      const baseFiles: StorageFile[] = [...now].map(([file, info]) => ({
        file,
        ...info,
      }));
      return { files: files.sort(), baseFiles };
    },

    async readBaseFiles(base, files) {
      files.forEach(assertBlockFile);
      const out: Record<string, StoredFileBody> = Object.create(null);
      const at = await scanAt(base);
      // HEAD moved: no base body, so the core reads the base again.
      if (!at) return out;
      const inBase = at.git.base;
      const wanted = files
        .filter((file) => inBase.has(file) && !hasControlCharacter(file))
        .map((file) => [file, inBase.get(file)!] as const);
      // Chunks bounded by count and bytes: each comes back through one read.
      let chunk: Array<[string, string]> = [];
      let bytes = 0;
      const flush = async () => {
        if (chunk.length === 0) return;
        const bodies = await readBaseChunk(chunk);
        for (const [file, blob] of chunk) {
          const text = bodies.get(file);
          if (text !== undefined) out[file] = { text, version: blob };
        }
        chunk = [];
        bytes = 0;
      };
      for (const [file, info] of wanted) {
        const size = info.size ?? 0;
        if (
          chunk.length >= BASE_READ_CHUNK_FILES ||
          (chunk.length > 0 && bytes + size > BASE_READ_CHUNK_BYTES)
        ) {
          await flush();
        }
        chunk.push([file, info.version]);
        bytes += size;
      }
      await flush();
      return out;
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
        if (
          attempt.expectedBase !== undefined &&
          (current.git?.head ?? null) !== attempt.expectedBase
        ) {
          return stale;
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
        // A discard also unstages what it restores, before writing, so a
        // failed write puts the index back too.
        const restage =
          attempt.reason === "discard"
            ? await unstage([...Object.keys(attempt.put), ...attempt.delete])
            : null;
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
          await restage?.undo().catch((restageError) =>
            console.error("sandbox content: restoring the index failed", {
              error:
                restageError instanceof Error
                  ? restageError.message
                  : String(restageError),
            }),
          );
          throw error;
        } finally {
          invalidate();
        }

        restage?.done();
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
