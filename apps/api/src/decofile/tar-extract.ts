/**
 * Streamed tarball extraction for the decofile cold read (see
 * disk-cache-spec.md §Cold read). The GitHub repo tarball is piped straight
 * from the network into a `tar` subprocess — the archive NEVER exists in the
 * JS heap (golden rule 1); the child does the gunzip off the event loop
 * (golden rule 5). Only `.deco/blocks/*.json` members are extracted, into a
 * caller-provided scratch dir, with the tarball's single top-level directory
 * stripped.
 *
 * Portability: GNU tar (Linux prod) requires `--wildcards` to treat member
 * arguments as globs; BSD tar (macOS dev) rejects `--wildcards` but globs by
 * default. The flavor is detected once per process from `tar --version`.
 * Both tars refuse `..`/absolute member paths by default, so extraction
 * cannot escape the scratch dir.
 *
 * Failures throw {@link TarExtractError}; the caller falls back to bounded
 * per-blob fetches. A partial or empty extraction never returns as success.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Typed failure: spawn error, non-zero exit, or an empty extraction. */
export class TarExtractError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TarExtractError";
  }
}

export type TarKind = "gnu" | "bsd";

/**
 * Argument list (after the `tar` binary itself) for extracting the matching
 * members. Pure, so both flavors are unit-testable on any platform.
 */
export function tarArgs(
  kind: TarKind,
  scratchDir: string,
  pattern: string,
): string[] {
  const base = ["-xz", "--strip-components=1", "-C", scratchDir];
  // GNU tar needs --wildcards for glob member patterns; BSD tar rejects the
  // flag and globs by default.
  return kind === "gnu"
    ? [...base, "--wildcards", pattern]
    : [...base, pattern];
}

let tarKindPromise: Promise<TarKind> | null = null;

/** Detect the system tar flavor once per process. A detection failure guesses
 * "bsd"; a truly missing binary surfaces as a spawn error in the extraction
 * itself. */
function detectTarKind(): Promise<TarKind> {
  tarKindPromise ??= (async () => {
    try {
      const proc = Bun.spawn(["tar", "--version"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return out.includes("GNU") ? "gnu" : "bsd";
    } catch {
      return "bsd";
    }
  })();
  return tarKindPromise;
}

/**
 * Stream `body` (a gzipped repo tarball) into `tar`, extracting only
 * `<blocksPathPrefix>/*.json` members (top-level component stripped) into
 * `scratchDir`. Returns each extracted file's repo-relative path and absolute
 * disk path — contents are deliberately NOT read here (the caller decides;
 * keeps this module heap-free).
 *
 * @throws TarExtractError on spawn failure, non-zero exit, or when nothing
 *   was extracted (the caller only takes this path when many blocks are
 *   expected, so an empty result is a failure, not a success).
 */
export async function extractBlocksFromTarball(
  body: ReadableStream<Uint8Array>,
  scratchDir: string,
  blocksPathPrefix: string,
): Promise<Array<{ path: string; diskPath: string }>> {
  const prefix = blocksPathPrefix
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (prefix === "" || prefix.split("/").includes("..")) {
    throw new TarExtractError(
      `invalid blocks path prefix: ${blocksPathPrefix}`,
    );
  }

  const kind = await detectTarKind();
  const pattern = `*/${prefix}/*.json`;

  const spawnTar = () =>
    Bun.spawn(["tar", ...tarArgs(kind, scratchDir, pattern)], {
      stdin: body,
      stdout: "ignore",
      stderr: "pipe",
    });
  let proc: ReturnType<typeof spawnTar>;
  try {
    proc = spawnTar();
  } catch (err) {
    throw new TarExtractError("failed to spawn tar", { cause: err });
  }

  // Consume stderr concurrently so a chatty tar can't deadlock on a full pipe.
  const stderrText = new Response(proc.stderr).text().catch(() => "");
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const detail = (await stderrText).trim().slice(0, 500);
    throw new TarExtractError(
      `tar exited with code ${exitCode}${detail ? `: ${detail}` : ""}`,
    );
  }

  const files = await collectExtracted(scratchDir, prefix);
  if (files.length === 0) {
    throw new TarExtractError(
      `tar extracted no ${pattern} members into ${scratchDir}`,
    );
  }
  return files;
}

/** List the extracted `<prefix>/*.json` files (the pattern only matches
 * direct children of the blocks dir). Deterministically sorted by path. */
async function collectExtracted(
  scratchDir: string,
  prefix: string,
): Promise<Array<{ path: string; diskPath: string }>> {
  const blocksDir = join(scratchDir, ...prefix.split("/"));
  let names: string[];
  try {
    names = await readdir(blocksDir);
  } catch {
    return []; // nothing extracted — caller turns this into a typed error
  }
  const out: Array<{ path: string; diskPath: string }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const diskPath = join(blocksDir, name);
    try {
      if (!(await stat(diskPath)).isFile()) continue;
    } catch {
      continue;
    }
    out.push({ path: `${prefix}/${name}`, diskPath });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
