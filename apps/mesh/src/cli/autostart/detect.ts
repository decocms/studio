/**
 * Detects whether the cwd looks like an MCP project that we can auto-launch.
 *
 * Trigger conditions, in priority order:
 *   1. <cwd>/mcp is a directory with package.json or deno.json → root = <cwd>/mcp
 *   2. <cwd> itself looks like an MCP project (api/main.*.ts, or @decocms/runtime
 *      / @modelcontextprotocol/sdk in deps) → root = <cwd>
 *   3. otherwise null
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm" | "deno";
export type Starter = "dev" | "start";

export interface DetectedProject {
  /** Absolute path of the project root we will spawn from. */
  root: string;
  /** Display title — README H1 → package.json#name (no @scope/) → basename. */
  name: string;
  packageManager: PackageManager;
  starter: Starter;
  /** Best-effort one-line description: package.json#description → first README paragraph. */
  description: string | null;
  /** First ~2KB of README.md, if any. */
  readmePreview: string | null;
  /** Path to an authored agent prompt (prompt.md / AGENTS.md / CLAUDE.md), if any. */
  promptFile: string | null;
}

const WELL_KNOWN_STARTERS = ["dev", "start"] as const;

const MCP_DEP_HINTS = [
  "@decocms/runtime",
  "@modelcontextprotocol/sdk",
  "@modelcontextprotocol/ext-apps",
];

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readJsonSafe<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function detectPackageManager(root: string): PackageManager | null {
  if (
    existsSync(join(root, "deno.json")) ||
    existsSync(join(root, "deno.jsonc"))
  ) {
    return "deno";
  }
  if (
    existsSync(join(root, "bun.lock")) ||
    existsSync(join(root, "bun.lockb"))
  ) {
    return "bun";
  }
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "package-lock.json"))) return "npm";
  // Fall back to bun if package.json exists — bunx decocms users likely use bun
  if (existsSync(join(root, "package.json"))) return "bun";
  return null;
}

function discoverStarter(root: string, pm: PackageManager): Starter | null {
  let scripts: Record<string, string> = {};
  if (pm === "deno") {
    for (const f of ["deno.json", "deno.jsonc"]) {
      const parsed = readJsonSafe<{ tasks?: Record<string, string> }>(
        join(root, f),
      );
      if (parsed) {
        scripts = parsed.tasks ?? {};
        break;
      }
    }
  } else {
    const parsed = readJsonSafe<{ scripts?: Record<string, string> }>(
      join(root, "package.json"),
    );
    scripts = parsed?.scripts ?? {};
  }
  for (const s of WELL_KNOWN_STARTERS) {
    if (scripts[s]) return s;
  }
  return null;
}

function readReadme(root: string, max: number): string | null {
  for (const name of ["README.md", "readme.md", "README.MD"]) {
    const p = join(root, name);
    if (!existsSync(p)) continue;
    try {
      return readFileSync(p, "utf-8").slice(0, max);
    } catch {
      // ignore
    }
  }
  return null;
}

function firstReadmeH1(readme: string | null): string | null {
  if (!readme) return null;
  for (const raw of readme.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("# ")) return line.slice(2).trim();
  }
  return null;
}

function firstReadmeParagraph(readme: string | null): string | null {
  if (!readme) return null;
  const lines = readme.split("\n");
  // Skip leading whitespace and the H1 (and any sub-heading immediately after).
  let i = 0;
  while (i < lines.length && (!lines[i]!.trim() || lines[i]!.startsWith("#")))
    i++;
  const buf: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) {
      if (buf.length > 0) break;
      continue;
    }
    if (line.startsWith("#")) break;
    buf.push(line);
  }
  const text = buf.join(" ").trim();
  return text || null;
}

function stripScope(name: string): string {
  return name.startsWith("@") ? name.split("/").slice(1).join("/") : name;
}

function resolveDisplayName(
  root: string,
  readme: string | null,
  pkgName: string | null,
): string {
  const fromReadme = firstReadmeH1(readme);
  if (fromReadme) return fromReadme;
  if (pkgName) return stripScope(pkgName);
  return basename(root);
}

function resolveDescription(
  pkgDescription: string | null,
  readme: string | null,
): string | null {
  if (pkgDescription) return pkgDescription;
  return firstReadmeParagraph(readme);
}

const PROMPT_CANDIDATES = ["prompt.md", "AGENTS.md", "CLAUDE.md"];

function findPromptFile(root: string): string | null {
  for (const name of PROMPT_CANDIDATES) {
    const p = join(root, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function hasMcpShape(root: string): boolean {
  // Existence of api/main.*.ts is the strongest signal.
  const apiDir = join(root, "api");
  if (isDir(apiDir)) {
    try {
      const entries = readdirSync(apiDir);
      if (entries.some((f) => /^main\.[^.]+\.ts$/.test(f))) return true;
    } catch {
      // ignore
    }
  }
  // Otherwise look for an MCP dependency.
  const pkg = readJsonSafe<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(join(root, "package.json"));
  if (pkg) {
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (MCP_DEP_HINTS.some((dep) => all[dep])) return true;
  }
  return false;
}

function tryDetect(root: string): DetectedProject | null {
  const pm = detectPackageManager(root);
  if (!pm) return null;
  const starter = discoverStarter(root, pm);
  if (!starter) return null;
  const pkg = readJsonSafe<{ name?: string; description?: string }>(
    join(root, "package.json"),
  );
  // Read enough of the README that firstReadmeParagraph has something to work
  // with even when the H1 is followed by long paragraphs.
  const readme = readReadme(root, 8192);
  return {
    root,
    name: resolveDisplayName(root, readme, pkg?.name?.trim() || null),
    packageManager: pm,
    starter,
    description: resolveDescription(pkg?.description?.trim() || null, readme),
    readmePreview: readme ? readme.slice(0, 2048) : null,
    promptFile: findPromptFile(root),
  };
}

export function detectProject(cwd: string): DetectedProject | null {
  // Priority 1: <cwd>/mcp
  const mcpDir = join(cwd, "mcp");
  if (isDir(mcpDir)) {
    const detected = tryDetect(mcpDir);
    if (detected) return detected;
  }
  // Priority 2: cwd itself, only if it has the shape (don't autostart random
  // node projects).
  if (hasMcpShape(cwd)) {
    return tryDetect(cwd);
  }
  return null;
}
