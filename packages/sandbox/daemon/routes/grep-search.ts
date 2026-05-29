import path from "node:path";
import { spawn } from "node:child_process";
import { safePath } from "../paths";
import { parseJsonBody, jsonResponse } from "./body-parser";

export type GrepBackend = "rg" | "grep";

const GREP_BACKENDS: readonly GrepBackend[] = ["rg", "grep"];

export type GrepRequestBody = {
  pattern?: string;
  path?: string;
  output_mode?: "files" | "count" | "content";
  ignore_case?: boolean;
  context?: number;
  glob?: string;
  limit?: number;
};

export interface GrepSearchDeps {
  appRoot: string;
  repoDir: string;
}

const GREP_EXCLUDE_DIRS = [
  "node_modules",
  ".git",
  ".deno",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".cache",
];

function spawnOpts(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...extra };
}

export function ripgrepInstallHint(): string {
  if (process.platform === "darwin") return "brew install ripgrep";
  if (process.platform === "linux") {
    return "apt-get install ripgrep (Debian/Ubuntu) or apk add ripgrep (Alpine)";
  }
  return "install ripgrep for your platform";
}

// GNU grep --include does not understand ripgrep-style **/ prefixes or {a,b} braces.
export function expandGlobForGrepInclude(glob: string): string[] {
  const pattern = glob.replace(/^\*\*\//, "").replace(/^\*\//, "");
  const braceMatch = pattern.match(/^(.*)\{([^}]+)\}(.*)$/);
  if (!braceMatch) return [pattern];
  const [, prefix, alternatives, suffix] = braceMatch;
  // Bare `{ts,tsx}` → `*.ts`, not `ts` (GNU --include needs a glob, not an extension).
  const effectivePrefix = prefix || "*.";
  return alternatives
    .split(",")
    .map((alt) => `${effectivePrefix}${alt.trim()}${suffix}`);
}

export function formatGrepToolError(
  stderr: string,
  code: number | null,
  backend: GrepBackend,
): { message: string; status: number } {
  const raw = stderr.trim();
  if (code === 2) {
    const cleaned = raw
      .replace(/^(grep|rg):\s*/i, "")
      .replace(/^error:\s*/i, "")
      .trim();
    if (
      /brackets|invalid regular expression|parse error|regex error|unclosed/i.test(
        cleaned,
      )
    ) {
      return {
        message: `Invalid regex pattern: ${cleaned}`,
        status: 400,
      };
    }
    return {
      message: cleaned || `Invalid search pattern (${backend})`,
      status: 400,
    };
  }
  return {
    message: raw || `${backend} failed with code ${code ?? "unknown"}`,
    status: 500,
  };
}

export function buildGrepArgs(
  body: GrepRequestBody,
  searchPath: string,
  backend: GrepBackend,
): string[] {
  const mode = body.output_mode ?? "files";
  if (backend === "rg") {
    const args: string[] = [];
    if (mode === "files") args.push("--files-with-matches");
    else if (mode === "count") args.push("--count");
    else args.push("--line-number");
    if (body.ignore_case) args.push("-i");
    if (body.context && mode === "content")
      args.push("-C", String(body.context));
    if (body.glob) args.push("--glob", body.glob);
    args.push("--color=never", "--", body.pattern!, searchPath);
    return args;
  }

  const args: string[] = ["-r", "-E"];
  if (mode === "files") args.push("-l");
  else if (mode === "count") args.push("-c");
  else args.push("-n");
  if (body.ignore_case) args.push("-i");
  if (body.context && mode === "content") args.push("-C", String(body.context));
  if (body.glob) {
    for (const include of expandGlobForGrepInclude(body.glob)) {
      args.push("--include", include);
    }
  }
  for (const dir of GREP_EXCLUDE_DIRS) args.push("--exclude-dir", dir);
  args.push("-e", body.pattern!, searchPath);
  return args;
}

/** Content-mode match lines use `file:line:…`; context lines use `file-line-…`. */
const CONTENT_MATCH_LINE = /^.+:\d+:/;
const GROUP_SEPARATOR = /^--$/;

export function relativizePath(filePath: string, repoDir: string): string {
  const normalizedRepo = path.resolve(repoDir);
  const normalizedFile = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(normalizedRepo, filePath);
  const rel = path.relative(normalizedRepo, normalizedFile);
  if (!rel || rel === ".") return filePath;
  if (rel.startsWith("..")) return filePath;
  return rel.split(path.sep).join("/");
}

function relativizeGrepLine(line: string, repoDir: string): string {
  if (GROUP_SEPARATOR.test(line)) return line;

  const contentMatch = line.match(/^(.+?):(\d+)([:|-])(.*)$/);
  if (contentMatch) {
    const [, filePart, lineNum, sep, rest] = contentMatch;
    return `${relativizePath(filePart, repoDir)}:${lineNum}${sep}${rest}`;
  }

  const countMatch = line.match(/^(.+?):(\d+)$/);
  if (countMatch) {
    const [, filePart, count] = countMatch;
    return `${relativizePath(filePart, repoDir)}:${count}`;
  }

  return relativizePath(line, repoDir);
}

export function isGrepMatchLine(
  line: string,
  mode: NonNullable<GrepRequestBody["output_mode"]>,
  hasContext: boolean,
): boolean {
  if (!line || GROUP_SEPARATOR.test(line)) return false;
  if (mode === "files" || mode === "count") return true;
  if (!hasContext) return CONTENT_MATCH_LINE.test(line);
  return CONTENT_MATCH_LINE.test(line);
}

export function normalizeGrepResults(
  stdout: string,
  repoDir: string,
  body: GrepRequestBody,
): { results: string; matchCount: number; lineCount: number } {
  const mode = body.output_mode ?? "files";
  const hasContext = Boolean(body.context && mode === "content");
  const lines = stdout ? stdout.split("\n") : [];
  const normalized: string[] = [];
  let matchCount = 0;
  let lineCount = 0;

  for (const line of lines) {
    if (!line) continue;
    const rel = relativizeGrepLine(line, repoDir);
    normalized.push(rel);
    lineCount++;
    if (isGrepMatchLine(rel, mode, hasContext)) matchCount++;
  }

  return {
    results: normalized.join("\n"),
    matchCount,
    lineCount,
  };
}

export async function runGrepCommand(
  backend: GrepBackend,
  args: string[],
  cwd: string,
  limit: number,
): Promise<{
  stdout: string;
  lineCount: number;
  stderr: string;
  code: number | null;
  spawnError: Error | null;
}> {
  const child = spawn(
    backend,
    args,
    spawnOpts({
      cwd,
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
  return { stdout, lineCount, stderr, code, spawnError };
}

function isExecutableMissing(err: Error | null): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

export function makeGrepHandler(deps: GrepSearchDeps) {
  return async (req: Request): Promise<Response> => {
    let body: GrepRequestBody;
    try {
      body = (await parseJsonBody(req)) as GrepRequestBody;
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

    const limit = body.limit ?? 250;
    let lastMissing: Error | null = null;

    for (const backend of GREP_BACKENDS) {
      const args = buildGrepArgs(body, searchPath, backend);
      const { stdout, stderr, code, spawnError } = await runGrepCommand(
        backend,
        args,
        deps.repoDir,
        limit,
      );

      if (spawnError) {
        if (isExecutableMissing(spawnError)) {
          lastMissing = spawnError;
          continue;
        }
        return jsonResponse(
          {
            error: `grep unavailable: ${spawnError.message}. Install ripgrep (${ripgrepInstallHint()}).`,
          },
          500,
        );
      }
      if (code !== null && code > 1) {
        const { message, status } = formatGrepToolError(stderr, code, backend);
        return jsonResponse({ error: message }, status);
      }

      const normalized = normalizeGrepResults(stdout, deps.repoDir, body);
      return jsonResponse({
        results: normalized.results,
        matchCount: normalized.matchCount,
      });
    }

    return jsonResponse(
      {
        error: `grep unavailable: neither ripgrep (rg) nor grep found on PATH${lastMissing ? `: ${lastMissing.message}` : ""}. Install ripgrep (${ripgrepInstallHint()}).`,
      },
      500,
    );
  };
}
