import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { PackageManager } from "../types";
import { repoHash } from "./golden-cache";

// Guard against a pathological node_modules blowing up the log line.
const MAX_DEPS = 10_000;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

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
  // A zero-dep install leaves no node_modules at all. Scanning it would throw
  // ENOENT into the catch below, which both swallows the countable zero-dep
  // line the denominator needs AND writes a spurious error to stderr on every
  // such boot. Return empty and let the caller emit the line.
  if (!(await exists(nodeModulesDir))) return [];
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
 * `l1` — reflinked the node-local golden, install skipped.
 * `l2` — extracted the shared cross-node archive; this node was cold.
 * `miss` — neither tier had it; ran a full install.
 * `no-install` — the runtime needed no install step at all, so no cache of
 *   any tier could have helped. Deno projects take this path (deno fetches at
 *   runtime and there is no `node_modules`), as does a repo with no manifest.
 *
 * The split is the whole point. `l1`/`miss` alone cannot say whether adding L2
 * helped, only that some boots are still cold: `l2` is the count of boots the
 * shared archive rescued, and its `duration_ms` beside `miss`'s is the saving.
 *
 * `no-install` is what makes the DENOMINATOR knowable, and it is load-bearing
 * for the buy decision. Without it, a boot the cache cannot serve is
 * indistinguishable from no boot at all — so a fleet that is mostly Deno reads
 * as "barely any dependency traffic" instead of "this cache is inapplicable
 * here", and its share is the ceiling on what any golden tier can ever win.
 */
export type RestoreSource = "l1" | "l2" | "miss" | "no-install";

export interface DepsRestoreInput {
  source: RestoreSource;
  /** Credential-bearing is fine — only its stripped hash is emitted. */
  cloneUrl: string | undefined;
  /** Whole dependency step, golden probe included (what L2 would replace). */
  durationMs: number;
  bootId: string;
}

/**
 * One line per completed dependency step, recording which cache tier served
 * it. This is the number the golden cache cannot report about itself: a hit
 * needs the pod to land on a node already warm for its repo, so the hit rate
 * is a property of fleet churn, not of the cache code.
 *
 * A log line rather than a metric, for three reasons:
 *  - it is the only channel that leaves a sandbox pod (see the note on
 *    `emitInstalledDeps` — egress is locked to 53/443, so no in-cluster OTLP
 *    collector is reachable);
 *  - `bootId` is free here and unbounded cardinality as a metric attribute.
 *    Without it a counter cannot tell "one pod installed three times" from
 *    "three pods", and `stepInstall` does re-run within a boot (config change,
 *    reprovision);
 *  - raw durations beat pre-bucketed histograms when the range is unknown,
 *    which is the whole point of measuring.
 *
 * Sized for the pipeline that drops big lines and samples bursts: ~150 bytes,
 * one per boot. Both limits are orders of magnitude away — no chunking, no
 * `sample_rate` correction.
 */
export function buildDepsRestoreLine(input: DepsRestoreInput): string {
  return JSON.stringify({
    msg: "sandbox.deps.restore",
    source: input.source,
    repo_hash: input.cloneUrl ? repoHash(input.cloneUrl) : "unknown",
    duration_ms: Math.round(input.durationMs),
    bootId: input.bootId,
  });
}

export function emitDepsRestore(input: DepsRestoreInput): void {
  try {
    console.log(buildDepsRestoreLine(input));
  } catch {
    // never let telemetry break the install path
  }
}

// Cap each emitted line SMALL. Measured in prod: the log pipeline stores only
// small lines from sandbox pods (observed max ~765 bytes across namespaces;
// the earlier ~15KB single-line format was rejected outright with
// "missing _msg field"). ~250-byte lines (the earlier per-dep format) survived
// reliably, so we keep lines well inside that proven range. This means many
// small lines per big install, which the collector may burst-sample — the
// panel sums `sample_rate` to correct for that (unsampled → sample_rate=1).
// We budget the FINAL line, not the raw array: `deps` is stored as a string,
// so the outer JSON.stringify escapes every element's quotes (`"x"` → `\"x\"`,
// +2 bytes each), which the per-element cost below accounts for.
const MAX_LINE_BYTES = 600;

// Bound the context fields so an unusually long branch/repo name can't inflate
// the per-line envelope past the small cap — that would push even a single-dep
// line over the limit and get the whole install's data dropped. 80 chars is
// plenty to identify a repo/branch; the full value is never needed here.
const MAX_META_BYTES = 80;
const clipMeta = (s: string | undefined): string | undefined =>
  s !== undefined && s.length > MAX_META_BYTES ? s.slice(0, MAX_META_BYTES) : s;

/** Greedily pack `name@version` strings into groups so each rendered line
 * (envelope + double-encoded deps) stays under MAX_LINE_BYTES. `envelopeBytes`
 * is the measured line size minus deps content; per element we add its escaped
 * cost: `\"<dep>\"` = byteLength+4, plus a comma. A single over-long dep still
 * gets its own group (a lone specifier is ~230 bytes, far under cap). */
function chunkByBytes(flat: string[], envelopeBytes: number): string[][] {
  const groups: string[][] = [];
  let cur: string[] = [];
  let bytes = envelopeBytes + 2; // + the enclosing []
  for (const dep of flat) {
    const entry = Buffer.byteLength(dep) + 5; // \"…\" (4) + comma (1)
    if (cur.length && bytes + entry > MAX_LINE_BYTES) {
      groups.push(cur);
      cur = [];
      bytes = envelopeBytes + 2;
    }
    cur.push(dep);
    bytes += entry;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/**
 * After a SUCCESSFUL install, emit the installed dependency set as JSON log
 * lines for downstream aggregation (VictoriaLogs) so the team can decide which
 * packages to pre-bake into the sandbox image. Logs, not metrics: per-package
 * cardinality would wreck Prometheus, and sandbox pods can't reach an
 * in-cluster OTLP collector anyway (egress is locked to 53/443), so their
 * stdout scraped out-of-band is the only channel that leaves the pod.
 *
 * Format is byte-bounded CHUNKED lines because both simpler shapes fail in
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
  const repoName = clipMeta(input.repoName);
  const branch = clipMeta(input.branch);
  // Measure the line minus dep content once (deps="", 3-digit chunk counts as
  // headroom) so the chunker can keep the FINAL line under the cap. Uses the
  // clipped meta so the budget matches what's actually emitted.
  const envelopeBytes = Buffer.byteLength(
    JSON.stringify({
      msg: "sandbox.deps",
      chunk: 999,
      chunks: 999,
      dependencyCount: deps.length,
      deps: "",
      bootId: input.bootId,
      packageManager: input.packageManager,
      repoName,
      branch,
    }),
  );
  const groups = chunkByBytes(flat, envelopeBytes);
  if (groups.length === 0) groups.push([]); // zero-dep install still emits one countable line
  return groups.map((group, i) =>
    JSON.stringify({
      msg: "sandbox.deps",
      chunk: i + 1,
      chunks: groups.length,
      dependencyCount: deps.length,
      deps: JSON.stringify(group),
      bootId: input.bootId,
      packageManager: input.packageManager,
      repoName,
      branch,
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
