import fs from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { safePath } from "../paths";
import { invalidDecofileBlockJson } from "../decofile-json";
import { parseJsonBody, jsonResponse } from "./body-parser";

/**
 * Wall-clock cap for fetches in write_from_url / upload_to_url.
 * Both endpoints only ever talk to studio-minted presigned S3/R2 URLs,
 * so the model has no path to influence the destination — the cap is
 * just defense against a hung S3 endpoint tying up a request slot.
 */
const TRANSFER_DEADLINE_MS = 5 * 60_000;

export interface FsDeps {
  /** Workspace root — the safety clamp for resolved paths. */
  appRoot: string;
  /**
   * Default base for resolving relative paths and as the cwd for
   * grep/glob. Typically `<appRoot>/repo` so the LLM's path UX matches
   * bash's cwd.
   */
  repoDir: string;
  /**
   * Called after a successful write/edit to the working tree (not a git
   * checkout or remote change). Lets the daemon refresh branch dirty state
   * without waiting for the `.git/` watcher poll.
   */
  onWorkingTreeWrite?: (path: string) => void;
}

function spawnOpts(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...extra };
}

/** Cap on bytes returned for image responses. ~5MB matches Anthropic's
 * vision input ceiling and keeps tool result payloads bounded. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Cap on bytes for write_from_url / upload_to_url. Matches the share
 * pipeline's expected file sizes (CSVs, decks, zips). Files past this
 * are out of scope for the chat artifact flow. */
const MAX_TRANSFER_BYTES = 500 * 1024 * 1024;

/** Magic-byte sniffer for the image types Claude vision accepts.
 * Returns null for everything else; we don't try to be clever about
 * arbitrary binary formats. */
function sniffImageMediaType(probe: Buffer): string | null {
  if (
    probe.length >= 3 &&
    probe[0] === 0xff &&
    probe[1] === 0xd8 &&
    probe[2] === 0xff
  )
    return "image/jpeg";
  if (
    probe.length >= 8 &&
    probe[0] === 0x89 &&
    probe[1] === 0x50 &&
    probe[2] === 0x4e &&
    probe[3] === 0x47 &&
    probe[4] === 0x0d &&
    probe[5] === 0x0a &&
    probe[6] === 0x1a &&
    probe[7] === 0x0a
  )
    return "image/png";
  if (
    probe.length >= 6 &&
    probe[0] === 0x47 &&
    probe[1] === 0x49 &&
    probe[2] === 0x46 &&
    probe[3] === 0x38
  )
    return "image/gif";
  if (
    probe.length >= 12 &&
    probe[0] === 0x52 &&
    probe[1] === 0x49 &&
    probe[2] === 0x46 &&
    probe[3] === 0x46 &&
    probe[8] === 0x57 &&
    probe[9] === 0x45 &&
    probe[10] === 0x42 &&
    probe[11] === 0x50
  )
    return "image/webp";
  return null;
}

/**
 * Resolves a user-supplied path. Absolute paths pass through as-is — OS
 * permissions already gate what the sandbox user can read. Relative paths
 * are resolved against `repoDir` (matching the bash cwd) and clamped to
 * `appRoot` (the workspace) so siblings like `../tmp/app/dev` reach.
 */
function resolveReadPath(
  appRoot: string,
  repoDir: string,
  userPath: string,
): string | null {
  if (path.isAbsolute(userPath)) return userPath;
  return safePath(appRoot, repoDir, userPath);
}

/**
 * On-disk name of the merged decofile artifact and its source directory.
 * `.deco/blocks.gen.json` is the runtime's merge of every `.deco/blocks/*.json`;
 * many repos gitignore it (it's a multi-MB single line that conflicts on every
 * content PR and is regenerated on dev cold-start), so a fresh sandbox has the
 * block sources but not the merged file.
 */
const DECOFILE_GEN_BASENAME = "blocks.gen.json";
const DECOFILE_BLOCKS_DIRNAME = "blocks";

/**
 * Rebuild `.deco/blocks.gen.json` from the sibling `.deco/blocks/*.json` files
 * so the CMS is readable before the dev server is up. The merge maps each file
 * to `{ [decodeURIComponent(stem)]: <file contents> }` — exactly what the deco
 * runtime emits (the filename stem is the `encodeURIComponent` of the block id).
 *
 * Kept off the critical path of the single-threaded event loop (daemon health
 * probe has a ~500ms budget): reads are async, and the file contents are
 * concatenated as raw text — no per-value `JSON.parse`/`JSON.stringify` over the
 * merge (only the small keys are JSON-encoded). The unavoidable full-payload
 * serialization happens once, downstream, when `jsonResponse` stringifies the
 * result — the same ~multi-MB cost the existing committed-file read path already
 * pays via `readFileSync` + `jsonResponse`, so this is no worse. A malformed
 * block isn't caught here; the client's `JSON.parse` fails and falls back to "no
 * snapshot", same as today — the write/edit handlers already gate validity.
 *
 * Returns `null` when there's no `blocks` dir (nothing to merge) so the caller
 * falls through to its normal "file not found" path.
 *
 * Prefer `generateDecofileFromBlocksDeduped` from request handlers: concurrent
 * cold reads (multiple tabs/users on a shared sandbox during boot) would each
 * rebuild the whole payload and their serialization bursts would serialize on
 * the loop, risking a missed health probe.
 */
export async function generateDecofileFromBlocks(
  blocksDir: string,
): Promise<string | null> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(blocksDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".json"))
    .map((e) => e.name)
    // Stable output order so byte-for-byte the artifact is deterministic.
    .sort();
  if (names.length === 0) return null;

  const parts: string[] = [];
  for (const name of names) {
    const stem = name.slice(0, -".json".length);
    let key: string;
    try {
      key = decodeURIComponent(stem);
    } catch {
      // A stem that isn't valid percent-encoding keeps its literal form,
      // mirroring the frontend's decoBlockKeyFromFileStem fallback.
      key = stem;
    }
    const raw = (await readFile(path.join(blocksDir, name), "utf-8")).trim();
    // Skip empty files — `"key":` with no value would break the merged JSON.
    if (!raw) continue;
    parts.push(`${JSON.stringify(key)}:${raw}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * Single-flight guard around {@link generateDecofileFromBlocks}: concurrent
 * reads for the same `blocksDir` share one in-flight rebuild instead of each
 * doing a full multi-MB merge. Keyed by absolute dir; the entry is cleared when
 * the build settles (resolve or reject). This is a boot-window coalescer, not a
 * cache — the next read after settle rebuilds, so it never serves stale content.
 */
const decofileBuildsInFlight = new Map<string, Promise<string | null>>();

export function generateDecofileFromBlocksDeduped(
  blocksDir: string,
): Promise<string | null> {
  const existing = decofileBuildsInFlight.get(blocksDir);
  if (existing) return existing;
  const build = generateDecofileFromBlocks(blocksDir).finally(() => {
    decofileBuildsInFlight.delete(blocksDir);
  });
  decofileBuildsInFlight.set(blocksDir, build);
  return build;
}

export function makeReadHandler(deps: FsDeps) {
  return async (req: Request): Promise<Response> => {
    let body: {
      path?: string;
      offset?: number;
      limit?: number;
      full?: boolean;
    };
    try {
      body = (await parseJsonBody(req)) as typeof body;
    } catch (e) {
      return jsonResponse({ error: (e as Error).message }, 400);
    }
    const filePath = resolveReadPath(
      deps.appRoot,
      deps.repoDir,
      body.path ?? "",
    );
    if (!filePath)
      return jsonResponse({ error: "Path escapes project root" }, 400);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      // Decofile fallback: when `.deco/blocks.gen.json` is absent (commonly
      // gitignored), regenerate it on the fly from the sibling `.deco/blocks/`
      // sources so the CMS is readable before the dev server boots. Returned
      // un-numbered (pretty JSON never matches the `^\d+\t` line-number prefix,
      // so the client's stripLineNumbers is a no-op and JSON.parse still works).
      if (path.basename(filePath) === DECOFILE_GEN_BASENAME) {
        const merged = await generateDecofileFromBlocksDeduped(
          path.join(path.dirname(filePath), DECOFILE_BLOCKS_DIRNAME),
        );
        if (merged !== null) {
          // lineCount is advisory here; the decofile is consumed as one blob.
          return jsonResponse({ kind: "text", content: merged, lineCount: 1 });
        }
      }
      return jsonResponse({ error: `File not found: ${body.path}` }, 400);
    }
    if (stat.isDirectory()) {
      return jsonResponse({ error: "Path is a directory" }, 400);
    }
    const fd = fs.openSync(filePath, "r");
    const probe = Buffer.alloc(Math.min(8192, stat.size));
    fs.readSync(fd, probe, 0, probe.length, 0);
    fs.closeSync(fd);

    const imageMediaType = sniffImageMediaType(probe);
    if (imageMediaType) {
      if (stat.size > MAX_IMAGE_BYTES) {
        return jsonResponse(
          {
            error: `Image too large (${stat.size} bytes; cap is ${MAX_IMAGE_BYTES})`,
          },
          400,
        );
      }
      const bytes = fs.readFileSync(filePath);
      return jsonResponse({
        kind: "image",
        mediaType: imageMediaType,
        size: stat.size,
        base64: bytes.toString("base64"),
      });
    }

    if (probe.includes(0))
      return jsonResponse(
        {
          error:
            "File appears to be binary and is not a supported image format (jpeg/png/gif/webp).",
        },
        400,
      );

    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split("\n");
    const offset = body.full ? 1 : Math.max(1, body.offset ?? 1);
    const limit = body.full ? lines.length : (body.limit ?? 2000);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join("\n");
    return jsonResponse({
      kind: "text",
      content: numbered,
      lineCount: lines.length,
    });
  };
}

export function makeWriteHandler(deps: FsDeps) {
  return async (req: Request): Promise<Response> => {
    let body: { path?: string; content?: string };
    try {
      body = (await parseJsonBody(req)) as typeof body;
    } catch (e) {
      return jsonResponse({ error: (e as Error).message }, 400);
    }
    if (typeof body.content !== "string")
      return jsonResponse({ error: "content is required" }, 400);
    const filePath = safePath(deps.appRoot, deps.repoDir, body.path ?? "");
    if (!filePath) return jsonResponse({ error: "Path escapes app root" }, 400);
    const jsonError = invalidDecofileBlockJson(body.path ?? "", body.content);
    if (jsonError)
      return jsonResponse({ error: `Refusing to write ${jsonError}` }, 400);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, body.content, "utf-8");
    deps.onWorkingTreeWrite?.(body.path ?? "");
    return jsonResponse({
      ok: true,
      bytesWritten: Buffer.byteLength(body.content, "utf-8"),
    });
  };
}

/**
 * Delete a file or directory inside the workspace. Symmetric with `write` —
 * same safePath clamp, same onWorkingTreeWrite signal so the branch
 * dirty-state recomputes. Idempotent (returns ok with `existed: false`
 * for a missing path) so the client can retry without races.
 */
export function makeUnlinkHandler(deps: FsDeps) {
  return async (req: Request): Promise<Response> => {
    let body: { path?: string; recursive?: boolean };
    try {
      body = (await parseJsonBody(req)) as typeof body;
    } catch (e) {
      return jsonResponse({ error: (e as Error).message }, 400);
    }
    if (!body.path || typeof body.path !== "string")
      return jsonResponse({ error: "path is required" }, 400);
    const normalized = body.path.replaceAll("\\", "/");
    const unlinkError = assertUnlinkAllowed(
      normalized,
      body.recursive === true,
    );
    if (unlinkError) {
      return jsonResponse({ error: unlinkError }, 400);
    }
    const filePath = safePath(deps.appRoot, deps.repoDir, body.path);
    if (!filePath) return jsonResponse({ error: "Path escapes app root" }, 400);
    let existed = true;
    try {
      const fileStat = await stat(filePath);
      if (fileStat.isDirectory()) {
        if (!body.recursive) {
          return jsonResponse(
            { error: "Refusing to unlink directory without recursive: true" },
            400,
          );
        }
        await rm(filePath, { recursive: true, force: true });
      } else {
        await unlink(filePath);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        existed = false;
      } else {
        return jsonResponse({ error: (err as Error).message }, 500);
      }
    }
    if (existed) deps.onWorkingTreeWrite?.(body.path ?? "");
    return jsonResponse({ ok: true, existed });
  };
}

export function makeMkdirHandler(deps: FsDeps) {
  return async (req: Request): Promise<Response> => {
    let body: { path?: string };
    try {
      body = (await parseJsonBody(req)) as typeof body;
    } catch (e) {
      return jsonResponse({ error: (e as Error).message }, 400);
    }
    if (!body.path || typeof body.path !== "string")
      return jsonResponse({ error: "path is required" }, 400);
    const normalized = body.path.replaceAll("\\", "/");
    if (!normalized || normalized.includes("..")) {
      return jsonResponse({ error: "Invalid path" }, 400);
    }
    const dirPath = safePath(deps.appRoot, deps.repoDir, body.path);
    if (!dirPath) return jsonResponse({ error: "Path escapes app root" }, 400);
    try {
      await mkdir(dirPath, { recursive: true });
    } catch (err) {
      return jsonResponse({ error: (err as Error).message }, 500);
    }
    deps.onWorkingTreeWrite?.(body.path);
    return jsonResponse({ ok: true });
  };
}

export function makeRenameHandler(deps: FsDeps) {
  return async (req: Request): Promise<Response> => {
    let body: { from?: string; to?: string };
    try {
      body = (await parseJsonBody(req)) as typeof body;
    } catch (e) {
      return jsonResponse({ error: (e as Error).message }, 400);
    }
    if (!body.from || typeof body.from !== "string")
      return jsonResponse({ error: "from is required" }, 400);
    if (!body.to || typeof body.to !== "string")
      return jsonResponse({ error: "to is required" }, 400);
    const fromNormalized = body.from.replaceAll("\\", "/");
    const toNormalized = body.to.replaceAll("\\", "/");
    if (
      !fromNormalized ||
      !toNormalized ||
      fromNormalized.includes("..") ||
      toNormalized.includes("..")
    ) {
      return jsonResponse({ error: "Invalid path" }, 400);
    }
    const fromPath = safePath(deps.appRoot, deps.repoDir, body.from);
    const toPath = safePath(deps.appRoot, deps.repoDir, body.to);
    if (!fromPath || !toPath) {
      return jsonResponse({ error: "Path escapes app root" }, 400);
    }
    try {
      fs.statSync(fromPath);
    } catch {
      return jsonResponse({ error: `Path not found: ${body.from}` }, 400);
    }
    try {
      fs.statSync(toPath);
      return jsonResponse({ error: `Path already exists: ${body.to}` }, 400);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        return jsonResponse({ error: (err as Error).message }, 500);
      }
    }
    try {
      fs.mkdirSync(path.dirname(toPath), { recursive: true });
      fs.renameSync(fromPath, toPath);
    } catch (err) {
      return jsonResponse({ error: (err as Error).message }, 500);
    }
    deps.onWorkingTreeWrite?.(body.to!);
    return jsonResponse({ ok: true });
  };
}

export function makeEditHandler(deps: FsDeps) {
  return async (req: Request): Promise<Response> => {
    let body: {
      path?: string;
      old_string?: string;
      new_string?: string;
      replace_all?: boolean;
    };
    try {
      body = (await parseJsonBody(req)) as typeof body;
    } catch (e) {
      return jsonResponse({ error: (e as Error).message }, 400);
    }
    const filePath = safePath(deps.appRoot, deps.repoDir, body.path ?? "");
    if (!filePath) return jsonResponse({ error: "Path escapes app root" }, 400);
    if (!body.old_string || typeof body.old_string !== "string")
      return jsonResponse({ error: "old_string is required" }, 400);
    if (typeof body.new_string !== "string")
      return jsonResponse({ error: "new_string is required" }, 400);
    if (body.old_string === body.new_string)
      return jsonResponse(
        { error: "old_string and new_string must differ" },
        400,
      );

    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      return jsonResponse({ error: `File not found: ${body.path}` }, 400);
    }
    const replaceAll = body.replace_all === true;
    const count = content.split(body.old_string).length - 1;
    if (count === 0)
      return jsonResponse({ error: "old_string not found in file" }, 400);
    if (!replaceAll && count > 1)
      return jsonResponse(
        {
          error: `old_string found ${count} times. Use replace_all or provide more context to make it unique.`,
        },
        400,
      );
    const updated = replaceAll
      ? content.replaceAll(body.old_string, body.new_string)
      : content.replace(body.old_string, body.new_string);
    const jsonError = invalidDecofileBlockJson(body.path ?? "", updated);
    if (jsonError)
      return jsonResponse({ error: `Refusing to write ${jsonError}` }, 400);
    await writeFile(filePath, updated, "utf-8");
    deps.onWorkingTreeWrite?.(body.path ?? "");
    return jsonResponse({
      ok: true,
      replacements: replaceAll ? count : 1,
      content: updated,
    });
  };
}

export function makeGrepHandler(deps: FsDeps) {
  return async (req: Request): Promise<Response> => {
    let body: {
      pattern?: string;
      path?: string;
      output_mode?: "files" | "count" | "content";
      ignore_case?: boolean;
      fixed_strings?: boolean;
      context?: number;
      glob?: string;
      limit?: number;
    };
    try {
      body = (await parseJsonBody(req)) as typeof body;
    } catch (e) {
      return jsonResponse({ error: (e as Error).message }, 400);
    }
    if (!body.pattern)
      return jsonResponse({ error: "pattern is required" }, 400);
    const searchPath = body.path
      ? safePath(deps.appRoot, deps.repoDir, body.path)
      : deps.repoDir;
    if (!searchPath)
      return jsonResponse({ error: "Path escapes app root" }, 400);
    const args: string[] = [];
    const mode = body.output_mode ?? "files";
    if (mode === "files") args.push("--files-with-matches");
    else if (mode === "count") args.push("--count");
    else args.push("--line-number");
    if (body.ignore_case) args.push("-i");
    if (body.fixed_strings) args.push("-F");
    if (body.context && mode === "content")
      args.push("-C", String(body.context));
    if (body.glob) args.push("--glob", body.glob);
    // `.deco/blocks/*.json` (the decofile sources) are tracked but live under a
    // dot-dir, so ripgrep's default dotfile skip hides them from content search
    // even though the filename glob (`dot: true`) surfaces them — the two
    // searches disagree. `--hidden` fixes that. We deliberately keep honoring
    // .gitignore/.git/info/exclude: the only gitignored `.deco` entries are the
    // multi-MB generated merge (`blocks.gen.json`, a duplicate of the sources)
    // and the sandbox's own local-only artifacts, plus repo secrets like
    // `.env` — none of which grep should re-admit into the file explorer or the
    // agent's Grep tool. `--hidden` re-enables descent into `.git` itself, so
    // the `!.git` entry below is load-bearing; the rest mirror the glob walk's
    // noise filter and trail any caller `--glob` so those dirs stay excluded.
    args.push("--hidden");
    for (const dir of GLOB_EXCLUDE_DIRS) args.push("--glob", `!${dir}`);
    args.push("--", body.pattern, searchPath);

    const limit = resolveGrepResultLimit(body.limit);
    // rg prints paths prefixed with the (absolute) search path argument. Strip
    // that back to a repo-relative path so grep matches glob's wire contract
    // (agents/tools glob+grep over repo-relative, POSIX-style paths). Every
    // mode's path is a literal prefix of the line — "files" mode emits a bare
    // path, "content"/"count" emit `path:rest`, and `-C` context rows emit
    // `path-rest` — so strip the known absolute prefix directly rather than
    // splitting on ":" (which misparses context rows' "-" separator and any
    // path that itself contains a colon).
    const relativizeGrepLine = (line: string): string =>
      toRepoRelativePath(line, searchPath, deps.repoDir);
    const child = spawn(
      "rg",
      args,
      spawnOpts({
        cwd: deps.repoDir,
        stdio: ["ignore", "pipe", "pipe"],
      }) as Parameters<typeof spawn>[2],
    );
    let stdout = "";
    let lineCount = 0;
    let truncated = false;
    // rg's stdout arrives in arbitrary chunk boundaries, which don't align
    // with line boundaries — buffer the trailing partial line across `data`
    // events instead of treating every chunk as whole lines (that would
    // corrupt/drop a match line split across two chunks).
    let pendingLine = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const pieces = (pendingLine + chunk.toString("utf-8")).split("\n");
      pendingLine = pieces.pop() ?? "";
      for (const line of pieces) {
        if (lineCount >= limit) {
          truncated = true;
          pendingLine = "";
          try {
            child.kill("SIGTERM");
          } catch {}
          break;
        }
        if (line) {
          stdout += (stdout ? "\n" : "") + relativizeGrepLine(line);
          lineCount++;
        }
      }
    });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    let spawnError: Error | null = null;
    const code: number | null = await new Promise((resolve) => {
      child.on("close", (c) => resolve(c));
      child.on("error", (err) => {
        spawnError = err;
        resolve(-1);
      });
    });
    if (spawnError) {
      return jsonResponse(
        {
          error: `grep unavailable: ${(spawnError as Error).message}. Install ripgrep ("brew install ripgrep") or use bash + grep.`,
        },
        500,
      );
    }
    if (code !== null && code > 1)
      return jsonResponse(
        { error: stderr || `rg failed with code ${code}` },
        500,
      );
    // Flush a final line left in the buffer with no trailing newline (rg was
    // killed or exited before emitting one).
    if (!truncated && pendingLine && lineCount < limit) {
      stdout += (stdout ? "\n" : "") + relativizeGrepLine(pendingLine);
      lineCount++;
    }
    return jsonResponse({ results: stdout, matchCount: lineCount });
  };
}

/**
 * GET a remote URL (typically a presigned S3 URL) and stream the bytes to
 * a path on the sandbox FS. Studio mints the URL and asks the daemon to
 * fetch it directly so bytes never round-trip through studio.
 *
 * Body: { path: string; url: string }
 */
// Unlike /write and /edit, this handler streams (potentially large, binary)
// presigned-URL payloads and deliberately does NOT validate decofile-block JSON
// — buffering the whole body to JSON.parse it would violate the daemon's
// no-blocking rule. publish() is the backstop that catches any invalid block
// written by this path (or any other) at the commit boundary.
export function makeWriteFromUrlHandler(deps: FsDeps) {
  return async (req: Request): Promise<Response> => {
    let body: { path?: string; url?: string };
    try {
      body = (await parseJsonBody(req)) as typeof body;
    } catch (e) {
      return jsonResponse({ error: (e as Error).message }, 400);
    }
    if (typeof body.url !== "string" || !body.url) {
      return jsonResponse({ error: "url is required" }, 400);
    }
    const filePath = safePath(deps.appRoot, deps.repoDir, body.path ?? "");
    if (!filePath) return jsonResponse({ error: "Path escapes app root" }, 400);

    // The URL here is studio-minted (presigned GET to S3/R2) — the model
    // can't supply arbitrary URLs through copy_to_sandbox, so SSRF +
    // DNS-rebinding defenses aren't needed. Plain fetch with a wall-
    // clock deadline is enough.
    const abortController = new AbortController();
    const deadlineTimer = setTimeout(
      () => abortController.abort(),
      TRANSFER_DEADLINE_MS,
    );
    let resp: Response;
    try {
      resp = await fetch(body.url, { signal: abortController.signal });
    } catch (err) {
      clearTimeout(deadlineTimer);
      return jsonResponse(
        {
          error: abortController.signal.aborted
            ? `fetch deadline exceeded (${TRANSFER_DEADLINE_MS}ms)`
            : `fetch failed: ${(err as Error).message}`,
        },
        502,
      );
    }
    if (!resp.ok || !resp.body) {
      clearTimeout(deadlineTimer);
      return jsonResponse(
        { error: `upstream returned HTTP ${resp.status}` },
        502,
      );
    }
    const contentLengthHeader = resp.headers.get("content-length");
    const declaredSize = contentLengthHeader
      ? Number.parseInt(contentLengthHeader, 10)
      : null;
    if (declaredSize !== null && declaredSize > MAX_TRANSFER_BYTES) {
      clearTimeout(deadlineTimer);
      return jsonResponse(
        {
          error: `Payload too large (${declaredSize} > ${MAX_TRANSFER_BYTES})`,
        },
        413,
      );
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // pipeline() guarantees: backpressure honored, errors propagate
    // through the chain, all streams destroyed on failure. The Transform
    // tracks running byte count so we fail fast when a server lies in
    // (or omits) Content-Length.
    let written = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        written += chunk.byteLength;
        if (written > MAX_TRANSFER_BYTES) {
          cb(new Error(`Stream exceeded ${MAX_TRANSFER_BYTES} bytes`));
          return;
        }
        cb(null, chunk);
      },
    });
    const out = fs.createWriteStream(filePath);
    try {
      await pipeline(Readable.fromWeb(resp.body as never), cap, out);
    } catch (err) {
      // Any failure (network RST, TLS error, size cap, write fault)
      // leaves a partial file. Remove it so a later skill step can't
      // read a half-baked artifact.
      fs.rmSync(filePath, { force: true });
      return jsonResponse(
        {
          error: abortController.signal.aborted
            ? `fetch deadline exceeded (${TRANSFER_DEADLINE_MS}ms)`
            : `stream failed: ${(err as Error).message}`,
        },
        502,
      );
    } finally {
      clearTimeout(deadlineTimer);
    }
    return jsonResponse({ ok: true, path: body.path, size: written });
  };
}

/**
 * Read a file from the sandbox FS and PUT it to a remote URL (typically
 * a presigned S3 URL). Studio mints the URL and asks the daemon to upload
 * directly so bytes never round-trip through studio.
 *
 * Body: { path: string; url: string; contentType?: string }
 */
export function makeUploadToUrlHandler(deps: FsDeps) {
  return async (req: Request): Promise<Response> => {
    let body: { path?: string; url?: string; contentType?: string };
    try {
      body = (await parseJsonBody(req)) as typeof body;
    } catch (e) {
      return jsonResponse({ error: (e as Error).message }, 400);
    }
    if (typeof body.url !== "string" || !body.url) {
      return jsonResponse({ error: "url is required" }, 400);
    }
    const filePath = resolveReadPath(
      deps.appRoot,
      deps.repoDir,
      body.path ?? "",
    );
    if (!filePath) {
      return jsonResponse({ error: "Path escapes project root" }, 400);
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return jsonResponse({ error: `File not found: ${body.path}` }, 400);
    }
    if (stat.isDirectory()) {
      return jsonResponse({ error: "Path is a directory" }, 400);
    }
    if (stat.size > MAX_TRANSFER_BYTES) {
      return jsonResponse(
        { error: `File too large (${stat.size} > ${MAX_TRANSFER_BYTES})` },
        413,
      );
    }

    const headers: Record<string, string> = {
      "Content-Length": String(stat.size),
    };
    if (body.contentType) headers["Content-Type"] = body.contentType;

    // Stream the file body — readFileSync at MAX_TRANSFER_BYTES would peg
    // ~25% of the daemon's memory cap on a single concurrent upload.
    // Bun.file().stream() returns a ReadableStream<Uint8Array> that fetch
    // accepts directly; backpressure stays on the network socket.
    const abortController = new AbortController();
    const deadlineTimer = setTimeout(
      () => abortController.abort(),
      TRANSFER_DEADLINE_MS,
    );
    let resp: Response;
    try {
      resp = await fetch(body.url, {
        method: "PUT",
        body: Bun.file(filePath).stream(),
        headers,
        signal: abortController.signal,
        // No SSRF revalidation here — the URL is studio-minted (presigned
        // PUT to S3/R2), so the model can't influence where bytes go.
        // upload PUTs don't redirect under S3/R2 semantics anyway.
      });
    } catch (err) {
      return jsonResponse(
        {
          error: abortController.signal.aborted
            ? `upload deadline exceeded (${TRANSFER_DEADLINE_MS}ms)`
            : `upload failed: ${(err as Error).message}`,
        },
        502,
      );
    } finally {
      clearTimeout(deadlineTimer);
    }
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return jsonResponse(
        {
          error: `upstream returned HTTP ${resp.status}: ${errText.slice(0, 500)}`,
        },
        502,
      );
    }
    return jsonResponse({ ok: true, size: stat.size });
  };
}

// Skipped during glob walk. node_modules/.git noise drowns out useful
// matches and isn't what the LLM ever wants to grep through.
const GLOB_EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".cache",
  ".ssh",
  ".aws",
  ".gnupg",
]);
/** Default cap for agent glob calls. */
export const GLOB_RESULT_LIMIT = 1000;
/** Hard ceiling when callers pass an explicit `limit` (file explorer). */
export const GLOB_MAX_RESULT_LIMIT = 10_000;

export function pathSegmentDepth(relPath: string): number {
  return relPath.split("/").filter(Boolean).length;
}

/** Register repo-relative ancestor directories up to `maxDepth`. */
export function registerGlobAncestorDirectories(
  repoRelativePath: string,
  maxDepth: number,
  directoryPaths: Set<string>,
  isFile: boolean,
): void {
  const parts = repoRelativePath.split("/").filter(Boolean);
  const dirParts = isFile ? parts.slice(0, -1) : parts;
  for (let i = 1; i <= Math.min(dirParts.length, maxDepth); i++) {
    directoryPaths.add(dirParts.slice(0, i).join("/"));
  }
}

/** Default cap for agent grep calls. */
export const GREP_RESULT_LIMIT = 250;
/** Hard ceiling when callers pass an explicit `limit` (file explorer). */
export const GREP_MAX_RESULT_LIMIT = 10_000;

/** Same shape as `resolveGlobResultLimit`, just a lower default (grep rows are wider than glob paths). */
export function resolveGrepResultLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return GREP_RESULT_LIMIT;
  const n = typeof limit === "number" ? limit : Number(limit);
  if (!Number.isFinite(n) || n < 1) return GREP_RESULT_LIMIT;
  return Math.min(Math.floor(n), GREP_MAX_RESULT_LIMIT);
}

export function resolveGlobResultLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return GLOB_RESULT_LIMIT;
  const n = typeof limit === "number" ? limit : Number(limit);
  if (!Number.isFinite(n) || n < 1) return GLOB_RESULT_LIMIT;
  return Math.min(Math.floor(n), GLOB_MAX_RESULT_LIMIT);
}

function repoRelativePrefix(searchPath: string, repoDir: string): string {
  if (searchPath === repoDir) return "";
  return path.relative(repoDir, searchPath).replace(/\\/g, "/");
}

function joinRepoRelative(prefix: string, name: string): string {
  return prefix ? `${prefix}/${name}` : name;
}

type GlobScanState = {
  filePaths: string[];
  directoryPaths: Set<string>;
  resultLimit: number;
};

/** Depth-bounded directory walk — avoids scanning the full tree for maxDepth. */
function walkRepoWithinMaxDepth(
  absDir: string,
  repoRelDir: string,
  maxDepth: number,
  state: GlobScanState,
): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    const childRel = joinRepoRelative(repoRelDir, entry.name);
    if (!isGlobPathAllowed(childRel)) continue;
    if (entry.isSymbolicLink()) continue;

    const depth = pathSegmentDepth(childRel);

    if (entry.isDirectory()) {
      if (depth > maxDepth) {
        registerGlobAncestorDirectories(
          childRel,
          maxDepth,
          state.directoryPaths,
          false,
        );
        continue;
      }
      state.directoryPaths.add(childRel);
      if (depth < maxDepth) {
        const childAbs = path.join(absDir, entry.name);
        if (walkRepoWithinMaxDepth(childAbs, childRel, maxDepth, state)) {
          return true;
        }
      }
    } else if (entry.isFile()) {
      if (depth > maxDepth) {
        registerGlobAncestorDirectories(
          childRel,
          maxDepth,
          state.directoryPaths,
          true,
        );
        continue;
      }
      state.filePaths.push(childRel);
      if (state.filePaths.length >= state.resultLimit) return true;
    }
  }
  return false;
}

function isGlobPathAllowed(rel: string): boolean {
  for (const seg of rel.split("/")) {
    if (GLOB_EXCLUDE_DIRS.has(seg)) return false;
  }
  return true;
}

/** Paths that must not be deleted via the sandbox unlink API. */
function assertUnlinkAllowed(
  normalized: string,
  recursive: boolean,
): string | null {
  if (!normalized || normalized.includes("..")) return "Invalid path";
  if (recursive && (normalized === "." || normalized === "")) {
    return "Refusing to recursively delete the repository root";
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.includes(".git")) {
    return "Refusing to delete .git";
  }
  return null;
}

/**
 * Repo-relative paths are a wire contract (agents/tools glob+grep over them)
 * that must always come back POSIX-style (forward slashes), regardless of
 * the platform separator `path.join`/`path.relative` used to build `abs`.
 * On win32 those use `\`, so a naive `${repoDir}/`-prefixed startsWith check
 * never matches (mixed separators) and silently falls through to returning
 * the untouched absolute path — normalize before comparing so this is
 * separator-agnostic on every platform.
 */
export function toRepoRelativePath(
  abs: string,
  searchPath: string,
  repoDir: string,
): string {
  const normalizedAbs = abs.replace(/\\/g, "/");
  const normalizedRepoDir = repoDir.replace(/\\/g, "/");
  const normalizedSearchPath = searchPath.replace(/\\/g, "/");
  if (normalizedAbs.startsWith(`${normalizedRepoDir}/`)) {
    return normalizedAbs.slice(normalizedRepoDir.length + 1);
  }
  if (normalizedAbs.startsWith(`${normalizedSearchPath}/`)) {
    return normalizedAbs.slice(normalizedSearchPath.length + 1);
  }
  return normalizedAbs;
}

/** Empty directories have no nested files and no nested directories in the scan. */
export function collectEmptyDirectories(
  filePaths: readonly string[],
  directoryPaths: readonly string[],
): string[] {
  const dirSet = new Set(directoryPaths);
  const empty: string[] = [];
  for (const dir of directoryPaths) {
    if (!dir) continue;
    const prefix = `${dir}/`;
    const hasNestedFile = filePaths.some((file) => file.startsWith(prefix));
    const hasNestedDirectory = [...dirSet].some(
      (other) => other !== dir && other.startsWith(prefix),
    );
    if (!hasNestedFile && !hasNestedDirectory) {
      empty.push(dir);
    }
  }
  return empty;
}

export function makeGlobHandler(deps: FsDeps) {
  return async (req: Request): Promise<Response> => {
    let body: {
      pattern?: string;
      path?: string;
      limit?: number;
      maxDepth?: number;
    };
    try {
      body = (await parseJsonBody(req)) as typeof body;
    } catch (e) {
      return jsonResponse({ error: (e as Error).message }, 400);
    }
    if (!body.pattern)
      return jsonResponse({ error: "pattern is required" }, 400);
    const searchPath = body.path
      ? safePath(deps.appRoot, deps.repoDir, body.path)
      : deps.repoDir;
    if (!searchPath)
      return jsonResponse({ error: "Path escapes app root" }, 400);

    const resultLimit = resolveGlobResultLimit(body.limit);
    const maxDepth =
      body.maxDepth === undefined || body.maxDepth === null
        ? undefined
        : Math.max(1, Math.floor(body.maxDepth));

    // Bun.Glob — no external binary dependency. Returns paths relative
    // to `cwd`, which we re-anchor to repoDir for consistent UX.
    const filePaths: string[] = [];
    const directoryPaths = new Set<string>();
    let truncated = false;
    try {
      if (maxDepth !== undefined && body.pattern === "**/*") {
        const state: GlobScanState = {
          filePaths,
          directoryPaths,
          resultLimit,
        };
        truncated = walkRepoWithinMaxDepth(
          searchPath,
          repoRelativePrefix(searchPath, deps.repoDir),
          maxDepth,
          state,
        );
      } else {
        const glob = new Bun.Glob(body.pattern);
        for await (const rel of glob.scan({
          cwd: searchPath,
          onlyFiles: false,
          followSymlinks: false,
          dot: true,
        })) {
          if (!isGlobPathAllowed(rel)) continue;
          const abs = path.join(searchPath, rel);
          let relPath: string;
          try {
            const stat = fs.statSync(abs);
            relPath = toRepoRelativePath(abs, searchPath, deps.repoDir);
            const depth = pathSegmentDepth(relPath);
            if (maxDepth !== undefined && depth > maxDepth) {
              registerGlobAncestorDirectories(
                relPath,
                maxDepth,
                directoryPaths,
                stat.isFile(),
              );
              continue;
            }
            if (stat.isDirectory()) {
              directoryPaths.add(relPath);
            } else if (stat.isFile()) {
              filePaths.push(relPath);
            }
          } catch {
            continue;
          }
          if (filePaths.length >= resultLimit) {
            truncated = true;
            break;
          }
        }
      }
    } catch (e) {
      return jsonResponse({ error: (e as Error).message }, 500);
    }
    const directories = collectEmptyDirectories(filePaths, [...directoryPaths]);
    return jsonResponse({
      files: filePaths,
      directories,
      ...(truncated ? { truncated: true } : {}),
    });
  };
}
