import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { safePath } from "../paths";
import { parseBase64JsonBody, jsonResponse } from "./body-parser";

/**
 * Wall-clock cap for fetches in write_from_url / upload_to_url.
 * Both endpoints only ever talk to mesh-minted presigned S3/R2 URLs,
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

export function makeReadHandler(deps: FsDeps) {
  return async (req: Request): Promise<Response> => {
    let body: { path?: string; offset?: number; limit?: number };
    try {
      body = (await parseBase64JsonBody(req)) as typeof body;
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
    const offset = Math.max(1, body.offset ?? 1);
    const limit = body.limit ?? 2000;
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
      body = (await parseBase64JsonBody(req)) as typeof body;
    } catch (e) {
      return jsonResponse({ error: (e as Error).message }, 400);
    }
    if (typeof body.content !== "string")
      return jsonResponse({ error: "content is required" }, 400);
    const filePath = safePath(deps.appRoot, deps.repoDir, body.path ?? "");
    if (!filePath) return jsonResponse({ error: "Path escapes app root" }, 400);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, body.content, "utf-8");
    return jsonResponse({
      ok: true,
      bytesWritten: Buffer.byteLength(body.content, "utf-8"),
    });
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
      body = (await parseBase64JsonBody(req)) as typeof body;
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
      content = fs.readFileSync(filePath, "utf-8");
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
    fs.writeFileSync(filePath, updated, "utf-8");
    return jsonResponse({ ok: true, replacements: replaceAll ? count : 1 });
  };
}

export function makeGrepHandler(deps: FsDeps) {
  return async (req: Request): Promise<Response> => {
    let body: {
      pattern?: string;
      path?: string;
      output_mode?: "files" | "count" | "content";
      ignore_case?: boolean;
      context?: number;
      glob?: string;
      limit?: number;
    };
    try {
      body = (await parseBase64JsonBody(req)) as typeof body;
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
    if (body.context && mode === "content")
      args.push("-C", String(body.context));
    if (body.glob) args.push("--glob", body.glob);
    args.push("--", body.pattern, searchPath);

    const limit = body.limit ?? 250;
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
    child.stdout!.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const lines = chunk.toString("utf-8").split("\n");
      for (const line of lines) {
        if (lineCount >= limit) {
          truncated = true;
          try {
            child.kill("SIGTERM");
          } catch {}
          break;
        }
        if (line) {
          stdout += (stdout ? "\n" : "") + line;
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
    return jsonResponse({ results: stdout, matchCount: lineCount });
  };
}

/**
 * GET a remote URL (typically a presigned S3 URL) and stream the bytes to
 * a path on the sandbox FS. Mesh mints the URL and asks the daemon to
 * fetch it directly so bytes never round-trip through mesh.
 *
 * Body: { path: string; url: string }
 */
export function makeWriteFromUrlHandler(deps: FsDeps) {
  return async (req: Request): Promise<Response> => {
    let body: { path?: string; url?: string };
    try {
      body = (await parseBase64JsonBody(req)) as typeof body;
    } catch (e) {
      return jsonResponse({ error: (e as Error).message }, 400);
    }
    if (typeof body.url !== "string" || !body.url) {
      return jsonResponse({ error: "url is required" }, 400);
    }
    const filePath = safePath(deps.appRoot, deps.repoDir, body.path ?? "");
    if (!filePath) return jsonResponse({ error: "Path escapes app root" }, 400);

    // The URL here is mesh-minted (presigned GET to S3/R2) — the model
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
 * a presigned S3 URL). Mesh mints the URL and asks the daemon to upload
 * directly so bytes never round-trip through mesh.
 *
 * Body: { path: string; url: string; contentType?: string }
 */
export function makeUploadToUrlHandler(deps: FsDeps) {
  return async (req: Request): Promise<Response> => {
    let body: { path?: string; url?: string; contentType?: string };
    try {
      body = (await parseBase64JsonBody(req)) as typeof body;
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
        // No SSRF revalidation here — the URL is mesh-minted (presigned
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
]);
const GLOB_RESULT_LIMIT = 1000;

export function makeGlobHandler(deps: FsDeps) {
  return async (req: Request): Promise<Response> => {
    let body: { pattern?: string; path?: string };
    try {
      body = (await parseBase64JsonBody(req)) as typeof body;
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

    // Bun.Glob — no external binary dependency. Returns paths relative
    // to `cwd`, which we re-anchor to repoDir for consistent UX.
    const glob = new Bun.Glob(body.pattern);
    const files: string[] = [];
    try {
      for await (const rel of glob.scan({
        cwd: searchPath,
        onlyFiles: true,
        followSymlinks: false,
      })) {
        if (rel.split("/").some((seg) => GLOB_EXCLUDE_DIRS.has(seg))) continue;
        const abs = path.join(searchPath, rel);
        files.push(
          abs.startsWith(`${deps.repoDir}/`)
            ? abs.slice(deps.repoDir.length + 1)
            : abs,
        );
        if (files.length >= GLOB_RESULT_LIMIT) break;
      }
    } catch (e) {
      return jsonResponse({ error: (e as Error).message }, 500);
    }
    return jsonResponse({ files });
  };
}
