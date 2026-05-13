/**
 * Runtime detection for public git URLs without OAuth.
 * Hits the GitHub Contents API without auth (60 req/hr per IP — fine for
 * occasional sandbox provisioning). Non-GitHub URLs return null immediately.
 *
 * Same lockfile-probe logic as github-runtime-detect.ts but requires no token.
 */

import type { DetectedRuntime } from "./github-runtime-detect";
import type { PackageManager } from "./runtime-defaults";

const LOCKFILES: Array<{ path: string; pm: PackageManager }> = [
  { path: "deno.json", pm: "deno" },
  { path: "deno.jsonc", pm: "deno" },
  { path: "bun.lock", pm: "bun" },
  { path: "bunfig.toml", pm: "bun" },
  { path: "pnpm-lock.yaml", pm: "pnpm" },
  { path: "yarn.lock", pm: "yarn" },
  { path: "package-lock.json", pm: "npm" },
  { path: "package.json", pm: "bun" },
];

const PORT_SOURCES: Partial<Record<PackageManager, string[]>> = {
  deno: ["deno.json", "deno.jsonc"],
  bun: ["package.json"],
  pnpm: ["package.json"],
  yarn: ["package.json"],
  npm: ["package.json"],
};

const PORT_RE = /(?:--port|PORT=|:)(\d{4,5})/;

function parseGitHubOwnerRepo(
  url: string,
): { owner: string; repo: string } | null {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("github.com")) return null;
    const parts = u.pathname
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0]!, repo: parts[1]! };
  } catch {
    return null;
  }
}

async function fetchPublicGitHubFile(
  owner: string,
  repo: string,
  path: string,
): Promise<string | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "mesh-runtime-detect",
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      content?: string;
      encoding?: string;
    };
    if (!body.content || body.encoding !== "base64") return null;
    return Buffer.from(body.content, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function extractDevPort(content: string | null): string | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as {
      tasks?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    const cmds = parsed.tasks ?? parsed.scripts ?? {};
    const cmd = cmds.dev ?? cmds.start ?? "";
    const match = cmd.match(PORT_RE);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Detect package manager and dev port from any public GitHub repo URL.
 * Returns null when the URL is not a GitHub URL, the repo is private/missing,
 * or no recognizable lockfile is found.
 */
export async function detectRuntimeFromPublicUrl(
  repoUrl: string,
): Promise<DetectedRuntime | null> {
  const parsed = parseGitHubOwnerRepo(repoUrl);
  if (!parsed) return null;

  const { owner, repo } = parsed;

  const relevantPaths = new Set(LOCKFILES.map((f) => f.path));
  for (const sources of Object.values(PORT_SOURCES)) {
    for (const p of sources ?? []) relevantPaths.add(p);
  }

  const cache = new Map<string, string | null>();
  await Promise.all(
    Array.from(relevantPaths).map(async (path) => {
      cache.set(path, await fetchPublicGitHubFile(owner, repo, path));
    }),
  );

  const hit = LOCKFILES.find(({ path }) => cache.get(path) !== null);
  if (!hit) return null;

  const portSources = PORT_SOURCES[hit.pm] ?? [];
  let devPort: string | null = null;
  for (const path of portSources) {
    devPort = extractDevPort(cache.get(path) ?? null);
    if (devPort) break;
  }

  return { packageManager: hit.pm, devPort };
}
