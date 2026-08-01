/**
 * Daemon-internal OTLP metrics — the TS twin of daemon-go's
 * `internal/telemetry`. Instrument names, units and attributes MUST stay
 * identical across the two daemons: the whole point is that a panel can split
 * one series by `daemon.impl` and compare ts against go. A rename on one side
 * doesn't break anything loudly, it just makes the comparison silently compare
 * nothing.
 *
 * These metrics exist because the equivalent stdout lines are sampled at 1% by
 * the log pipeline, which is fine for a fleet-wide rate and useless at canary
 * volume.
 *
 * Unlike Go, instruments are created INSIDE `initTelemetry`, not at module
 * scope: `@opentelemetry/api`'s metrics surface has no proxy meter provider
 * (only tracing does), so an instrument taken from the global before a real
 * provider is installed stays a no-op forever.
 */

import { hostname } from "node:os";
import type { Counter, Histogram } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";

const SCOPE = "github.com/decocms/studio/sandbox-daemon";

// A sandbox's median life is minutes, so the SDK's 60s default would lose
// short-lived pods entirely; faster buys nothing, since these instruments fire
// a handful of times per boot. Read here rather than left to the SDK so the
// standard OTel knob works regardless of which env vars this SDK version parses.
const DEFAULT_EXPORT_INTERVAL_MS = 30_000;

let phaseDuration: Histogram | undefined;
let depsRestore: Counter | undefined;
let depsRestoreDuration: Histogram | undefined;

const noopShutdown = async (): Promise<void> => {};

/**
 * Installs the OTLP metric pipeline. Returns a shutdown function that is safe
 * to call whether or not an exporter was started.
 *
 * No endpoint configured is the normal, expected case (desktop, local dev, any
 * deploy that has not opted in) — it returns a no-op and no error.
 */
export function initTelemetry(
  bootId: string,
  impl: string,
): () => Promise<void> {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return noopShutdown;

  try {
    // Merge, not replace: the default resource carries telemetry.sdk.* and the
    // service.name fallback.
    const resource = defaultResource().merge(
      resourceFromAttributes({
        "service.name": "studio-sandbox-daemon",
        // The pod name is the join key back to the k8s labels Studio stamps
        // (org, user, sandbox handle, daemon-impl). Carrying tenant identity in
        // the metric itself would put org and user ids on every series; the pod
        // name keeps cardinality flat and the join available.
        "k8s.pod.name": hostname(),
        // The comparison dimension for the Go rollout. Also on the pod label
        // and the boot log line; all three must agree.
        "daemon.impl": impl,
        "daemon.boot_id": bootId,
      }),
    );

    const provider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(),
          exportIntervalMillis:
            Number(process.env.OTEL_METRIC_EXPORT_INTERVAL) ||
            DEFAULT_EXPORT_INTERVAL_MS,
        }),
      ],
    });

    const meter = provider.getMeter(SCOPE);

    phaseDuration = meter.createHistogram("sandbox.daemon.phase.duration", {
      unit: "ms",
      description:
        "Wall-clock duration of each setup phase (clone, install, dev-server start). The per-phase boot cost breakdown, which exists nowhere outside the daemon: Studio sees only the total time until the sandbox answers.",
    });

    depsRestore = meter.createCounter("sandbox.daemon.deps.restore", {
      unit: "{step}",
      description:
        "Dependency-install outcomes by cache tier (l1 / l2 / miss / no-install). The golden-cache hit rate. Also emitted as a stdout line, but that path is sampled at 1% by the log pipeline and cannot be counted on.",
    });

    depsRestoreDuration = meter.createHistogram(
      "sandbox.daemon.deps.restore.duration",
      {
        unit: "ms",
        description:
          "Wall-clock duration of the dependency step, split by cache tier. A cache hit that is not meaningfully faster than a miss is the signal that the cache is not paying for itself.",
      },
    );

    console.log(
      `[daemon] otlp metrics enabled endpoint=${process.env.OTEL_EXPORTER_OTLP_ENDPOINT} impl=${impl} boot_id=${bootId}`,
    );

    return () => provider.shutdown();
  } catch (err) {
    // Telemetry must never break a boot.
    console.warn("[daemon] otlp metrics init failed", err);
    return noopShutdown;
  }
}

/**
 * Reports one finished setup phase. `status` is "done" or "failed" — a failed
 * phase is a boot that produced a duration but not a sandbox, and averaging the
 * two together hides exactly the regression a canary looks for.
 */
export function recordPhase(
  name: string,
  status: string,
  durationMs: number,
): void {
  phaseDuration?.record(durationMs, { phase: name, status });
}

/** Reports one dependency step and which cache tier served it. */
export function recordDepsRestore(source: string, durationMs: number): void {
  const attrs = { source };
  depsRestore?.add(1, attrs);
  depsRestoreDuration?.record(durationMs, attrs);
}
