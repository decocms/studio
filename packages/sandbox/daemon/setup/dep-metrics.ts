import { join } from "node:path";
import type { PackageManager } from "../types";

// Guard against a pathological node_modules blowing up the log line.
const MAX_DEPS = 10_000;

/**
 * True when a `package.json` (path relative to node_modules) is a real package
 * manifest — its dir sits directly under a `node_modules` or a scope dir. This
 * rejects fixture/sample `package.json` files shipped deep inside packages.
 */
export function isPackageManifest(rel: string): boolean {
  const d = rel.split("/").slice(0, -1);
  const n = d.length;
  if (n === 0) return false;
  if (n >= 2 && d[n - 2].startsWith("@")) {
    return n === 2 || d[n - 3] === "node_modules";
  }
  return n === 1 || d[n - 2] === "node_modules";
}

/**
 * Flattened installed dependency set, read straight from the on-disk
 * node_modules (PM-agnostic — works for npm/pnpm/yarn/bun without parsing four
 * lockfile formats). `followSymlinks: false` + `dot: true` picks up pnpm's real
 * package dirs under `.pnpm/` while skipping its top-level symlinks, so every
 * PM yields the same flattened `name@version` set (deduped).
 */
async function readInstalledDeps(
  nodeModulesDir: string,
): Promise<{ name: string; version: string }[]> {
  const seen = new Map<string, { name: string; version: string }>();
  const glob = new Bun.Glob("**/package.json");
  for await (const rel of glob.scan({
    cwd: nodeModulesDir,
    followSymlinks: false,
    dot: true,
  })) {
    if (seen.size >= MAX_DEPS) break;
    if (!isPackageManifest(rel)) continue;
    try {
      const raw = await Bun.file(join(nodeModulesDir, rel)).json();
      const name = raw?.name;
      const version = raw?.version;
      if (typeof name !== "string" || typeof version !== "string") continue;
      seen.set(`${name}@${version}`, { name, version });
    } catch {
      // unreadable / partial manifest — skip
    }
  }
  return [...seen.values()];
}

export interface DepMetricsInput {
  installRoot: string;
  packageManager: PackageManager;
  bootId: string;
  repoName?: string;
  branch?: string;
}

/**
 * After a SUCCESSFUL install, emit the installed dependency set as a single
 * JSON log line for downstream aggregation (VictoriaLogs) so the team can
 * decide which packages to pre-bake into the sandbox image. Logs, not metrics:
 * per-package cardinality would wreck Prometheus, and sandbox pods can't reach
 * an in-cluster OTLP collector anyway (egress is locked to 53/443), so their
 * stdout scraped out-of-band is the only channel that leaves the pod.
 * Best-effort: observability only, never throws.
 */
export async function emitInstalledDeps(input: DepMetricsInput): Promise<void> {
  try {
    const deps = await readInstalledDeps(
      join(input.installRoot, "node_modules"),
    );
    console.log(
      JSON.stringify({
        msg: "sandbox.install.deps",
        bootId: input.bootId,
        packageManager: input.packageManager,
        repoName: input.repoName,
        branch: input.branch,
        dependencyCount: deps.length,
        dependencies: deps,
      }),
    );
  } catch (err) {
    console.warn("[install] dep metrics emit failed", err);
  }
}
