/**
 * Dependency-install cache metrics.
 *
 * Answers the one question the golden cache can't answer about itself: how
 * often does a fresh pod actually hit it? The golden is node-local, so a hit
 * requires landing on a node already warm for that repo — and whether that
 * happens is a property of the fleet (pod churn, AZ spread), not of the cache
 * code. `source` splits the outcomes and `repo_hash` shows how concentrated
 * repos are per node, which together size the cross-node (EFS L2) work.
 *
 * Only recorded for install paths that COMPLETED — an `l1` restore or a
 * successful install. Failed installs are excluded deliberately: the ratio we
 * want is "did the cache save a boot", and a failure saved nothing either way.
 */

import { metrics } from "@opentelemetry/api";
import type { Counter, Histogram } from "@opentelemetry/api";
import { repoHash } from "./golden-cache";

/**
 * `l1` — reflinked the node-local golden, install skipped.
 * `miss` — no golden for this (repo, lockfile) on this node; ran a full install.
 * `l2` joins this union when the EFS archive tier lands.
 */
export type RestoreSource = "l1" | "miss";

interface Instruments {
  restore: Counter;
  installMs: Histogram;
  restoreMs: Histogram;
}

// Resolved per call, deliberately uncached. The metrics API reads the global
// provider at call time and never proxies a later registration, so a cached
// instrument taken before `initTelemetry()` would record into the void forever
// — silently, since nothing throws. This runs about once per pod boot, so
// there is nothing to optimize away and no ordering trap to document.
function getInstruments(): Instruments {
  const meter = metrics.getMeter("link-daemon");
  return {
    restore: meter.createCounter("studio.sandbox.deps.restore", {
      description:
        "Dependency install outcomes, split by which cache tier served them",
    }),
    installMs: meter.createHistogram("studio.sandbox.deps.install_ms", {
      description: "Wall-clock cost of a full dependency install (cache miss)",
      unit: "ms",
    }),
    restoreMs: meter.createHistogram("studio.sandbox.deps.restore_ms", {
      description: "Wall-clock cost of restoring dependencies from a cache",
      unit: "ms",
    }),
  };
}

/**
 * Record one completed dependency-install path. Best-effort: telemetry must
 * never fail a boot, so everything here is swallowed.
 */
export function recordDepsRestore(input: {
  source: RestoreSource;
  cloneUrl: string | undefined;
  durationMs: number;
}): void {
  try {
    const { restore, installMs, restoreMs } = getInstruments();
    // Attributes are fixed keys with derived values only — nothing
    // tenant-authored reaches the collector from a pod running user code.
    // `repoHash` is the cache's own key (16 hex chars), so a series lines up
    // with the golden dir on disk and the attribute is inherently bounded.
    const attrs = {
      source: input.source,
      repo_hash: input.cloneUrl ? repoHash(input.cloneUrl) : "unknown",
    };
    restore.add(1, attrs);
    if (input.source === "miss") {
      installMs.record(input.durationMs, attrs);
    } else {
      restoreMs.record(input.durationMs, attrs);
    }
  } catch {
    // never let a metric break the install path
  }
}
