/**
 * Daemon metrics export.
 *
 * PUSH, not scrape. Sandbox pods are too ephemeral to be a Prometheus target —
 * a pod that boots, installs and is reclaimed between two scrape windows
 * reports nothing, and boot-time numbers are exactly what we want. So the
 * daemon owns a MeterProvider and pushes over OTLP, with a flush on shutdown
 * (see `flushTelemetry`) so the last interval's points still ship.
 *
 * Dormant by default: with no OTEL_EXPORTER_OTLP_ENDPOINT no provider is
 * registered, `metrics.getMeter()` stays the API's no-op, and this module costs
 * one env read. That is today's behavior — enabling is a chart change.
 *
 * Egress caveat for whoever wires the endpoint: sandbox pods enforce egress via
 * the netinit iptables init container, which REJECTs the RFC1918 blockCIDRs
 * *before* the port ACCEPTs. An in-cluster ClusterIP collector is therefore
 * unreachable no matter which port is added to `allowedTCPPorts`. Point this at
 * an endpoint that clears that rule (e.g. the collector's LoadBalancer on 443).
 */

import { metrics } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { sleep } from "@decocms/shared/std";

const EXPORT_INTERVAL_MS = 60_000;

// Tail budget for the shutdown flush. `shutdown()` starts the flush before the
// git sync and awaits it after, so this is only the slice left over once the
// user's work is safely pushed — it must not eat into the 30s grace period the
// push depends on. OTLP acks 202 without waiting on downstream ingestion, so a
// healthy collector answers in well under a second.
const FLUSH_TIMEOUT_MS = 3_000;

let provider: MeterProvider | null = null;

/**
 * Register the global MeterProvider. No-op without an OTLP endpoint, and
 * idempotent. Must run before the first `getMeter()` call that matters: the
 * metrics API resolves the provider at call time and does NOT proxy a later
 * registration, so instruments created before this are permanently no-op.
 * Callers create instruments lazily to respect that (see setup/install-metrics).
 */
export function initTelemetry(): void {
  if (provider || !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  provider = new MeterProvider({
    resource: resourceFromAttributes({
      "service.name": process.env.OTEL_SERVICE_NAME ?? "studio-sandbox-daemon",
    }),
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: EXPORT_INTERVAL_MS,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(provider);
}

/**
 * Start exporting whatever is buffered. Returns a promise that always resolves
 * — a dead or slow collector must never delay shutdown past the timeout, and
 * must never surface as an error on a path whose real job is saving the user's
 * work. Resolves immediately when telemetry is off.
 */
export function flushTelemetry(): Promise<void> {
  const p = provider;
  if (!p) return Promise.resolve();
  return Promise.race([p.forceFlush(), sleep(FLUSH_TIMEOUT_MS)]).then(
    () => {},
    () => {},
  );
}
