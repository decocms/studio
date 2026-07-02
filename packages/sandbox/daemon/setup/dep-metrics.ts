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

// ~200 name@version strings ≈ 7KB/line: under the pipeline's 16KB line
// truncation, and 1-3 lines per install stays under its burst sampler.
const DEPS_PER_LINE = 200;

/**
 * After a SUCCESSFUL install, emit the installed dependency set as JSON log
 * lines for downstream aggregation (VictoriaLogs) so the team can decide which
 * packages to pre-bake into the sandbox image. Logs, not metrics: per-package
 * cardinality would wreck Prometheus, and sandbox pods can't reach an
 * in-cluster OTLP collector anyway (egress is locked to 53/443), so their
 * stdout scraped out-of-band is the only channel that leaves the pod.
 *
 * Format is CHUNKED lines of ~200 deps because both simpler shapes fail in
 * the pipeline (observed in prod, not hypothetical):
 *  - one line with the whole array → truncated at 16KB → unparseable JSON;
 *  - one line per dep → ~350-line burst per install → the collector's rate
 *    sampler drops ~99% (survivors arrive tagged sample_rate=100).
 * `deps` is a pre-JSON-encoded string (not a real array) so no pipeline stage
 * can flatten or re-shape it; VictoriaLogs `unroll (deps)` parses it back
 * into per-dep rows for `stats by (deps) count()`. Best-effort: never throws.
 */
export function buildDepLines(
  deps: { name: string; version: string }[],
  input: Omit<DepMetricsInput, "installRoot">,
): string[] {
  const flat = deps.map((d) => `${d.name}@${d.version}`);
  const chunks = Math.max(1, Math.ceil(flat.length / DEPS_PER_LINE));
  return Array.from({ length: chunks }, (_, i) =>
    JSON.stringify({
      msg: "sandbox.deps",
      chunk: i + 1,
      chunks,
      dependencyCount: deps.length,
      deps: JSON.stringify(
        flat.slice(i * DEPS_PER_LINE, (i + 1) * DEPS_PER_LINE),
      ),
      bootId: input.bootId,
      packageManager: input.packageManager,
      repoName: input.repoName,
      branch: input.branch,
    }),
  );
}

export async function emitInstalledDeps(input: DepMetricsInput): Promise<void> {
  try {
    const deps = await readInstalledDeps(
      join(input.installRoot, "node_modules"),
    );
    for (const line of buildDepLines(deps, input)) console.log(line);
  } catch (err) {
    console.warn("[install] dep metrics emit failed", err);
  }
}
