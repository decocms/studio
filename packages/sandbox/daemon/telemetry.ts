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
  AggregationType,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";

const SCOPE = "github.com/decocms/studio/sandbox-daemon";

/**
 * Explicit buckets for the boot-cost histograms, shared verbatim with
 * daemon-go. Two panels can only be compared if their buckets agree, and the
 * OTel default set stops at 10s — a clone or install routinely exceeds that, so
 * on the default every interesting boot lands in `+Inf` and every percentile
 * above p50 is a fabrication. Range chosen to cover a warm restore (~100ms) to
 * a cold install on a starved node (minutes).
 */
const DURATION_BUCKETS_MS = [
  50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 20_000, 30_000, 60_000,
  120_000, 300_000,
];

/**
 * Loop lag lives in a different range entirely — sub-millisecond when healthy,
 * and the interesting question is "did it cross ~1s", not "was it 30s or 60s".
 */
const LAG_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 5_000, 30_000];

/**
 * How often the lag sampler ticks. Cheap enough to leave on always (one timer
 * wake per second), fine-grained enough to catch the multi-second sync blocks
 * that make the daemon miss its health probe.
 */
const LAG_SAMPLE_INTERVAL_MS = 1_000;

// A sandbox's median life is minutes, so the SDK's 60s default would lose
// short-lived pods entirely; faster buys nothing, since these instruments fire
// a handful of times per boot. Read here rather than left to the SDK so the
// standard OTel knob works regardless of which env vars this SDK version parses.
const DEFAULT_EXPORT_INTERVAL_MS = 30_000;

let phaseDuration: Histogram | undefined;
let depsRestore: Counter | undefined;
let depsRestoreDuration: Histogram | undefined;
let readyDuration: Histogram | undefined;
let loopLag: Histogram | undefined;
let proxyDuration: Histogram | undefined;
let devServerExit: Counter | undefined;
let publishDuration: Histogram | undefined;

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
      views: [
        {
          instrumentName: "sandbox.daemon.loop.lag",
          aggregation: {
            type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
            options: { boundaries: LAG_BUCKETS_MS },
          },
        },
        // Everything else measured in ms. Listed by wildcard so an instrument
        // added later inherits the shared buckets instead of silently falling
        // back to the 10s-capped default.
        {
          instrumentName: "sandbox.daemon.*.duration",
          aggregation: {
            type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
            options: { boundaries: DURATION_BUCKETS_MS },
          },
        },
      ],
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

    readyDuration = meter.createHistogram("sandbox.daemon.ready.duration", {
      unit: "ms",
      description:
        "Daemon boot to the dev server answering, recorded once per boot. The in-pod half of cold start: Studio's own claim-to-answering number folds in scheduling and image pull, which no daemon change can move.",
    });

    loopLag = meter.createHistogram("sandbox.daemon.loop.lag", {
      unit: "ms",
      description:
        "Scheduling delay of a fixed-interval timer. A blocked loop (TS) or a descheduled process (both) stops the daemon answering its health probe, and Studio tears the sandbox down on a single miss — this is the only signal that says why, while the pod is still alive to say it.",
    });

    proxyDuration = meter.createHistogram("sandbox.daemon.proxy.duration", {
      unit: "ms",
      description:
        "Time to proxy one request to the user's dev server. Separates a slow sandbox from a slow app — nothing outside the pod can see this hop.",
    });

    devServerExit = meter.createCounter("sandbox.daemon.devserver.exit", {
      unit: "{exit}",
      description:
        "Dev-server process exits, split by whether the daemon asked for it. Unintentional exits are a crashlooping user app, which reads identically to a broken sandbox from the outside.",
    });

    publishDuration = meter.createHistogram("sandbox.daemon.publish.duration", {
      unit: "ms",
      description:
        "The SIGTERM git sync — the one irrecoverable step of a teardown, and the reason the pod grace period is 90s. How close this runs to the grace period is how much of the user's work is one slow push from being lost.",
    });

    startLoopLagSampler();

    console.log(
      `[daemon] otlp metrics enabled endpoint=${process.env.OTEL_EXPORTER_OTLP_ENDPOINT} impl=${impl} boot_id=${bootId}`,
    );

    return async () => {
      stopLoopLagSampler();
      await provider.shutdown();
    };
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

/**
 * Reports the boot that produced a serving sandbox. Called once per boot — a
 * dev server that crashes and comes back is a restart, not a second cold start,
 * and counting it as one would flatter every average.
 */
export function recordReady(durationMs: number): void {
  readyDuration?.record(durationMs);
}

/** Reports one proxied request to the user's dev server. */
export function recordProxy(durationMs: number, statusClass: string): void {
  proxyDuration?.record(durationMs, { status_class: statusClass });
}

/** Reports one dev-server process exit. */
export function recordDevServerExit(intentional: boolean): void {
  devServerExit?.add(1, { intentional: String(intentional) });
}

/** Reports the shutdown git sync. `status` is "done" or "failed". */
export function recordPublish(status: string, durationMs: number): void {
  publishDuration?.record(durationMs, { status });
}

let lagTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Samples how late a fixed-interval timer actually fires. On the TS daemon that
 * lateness IS the event-loop block (CONTRIBUTING rule #1); on a starved node it
 * is the scheduler. Both are the same failure from the sandbox's point of view,
 * which is why daemon-go samples the same way under the same instrument name.
 */
function startLoopLagSampler(): void {
  let expected = Date.now() + LAG_SAMPLE_INTERVAL_MS;
  lagTimer = setInterval(() => {
    const now = Date.now();
    loopLag?.record(Math.max(0, now - expected));
    expected = now + LAG_SAMPLE_INTERVAL_MS;
  }, LAG_SAMPLE_INTERVAL_MS);
  // Never hold the process open for telemetry.
  lagTimer.unref?.();
}

function stopLoopLagSampler(): void {
  if (lagTimer) clearInterval(lagTimer);
  lagTimer = undefined;
}
