import { describe, expect, test } from "bun:test";
import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { recordDepsRestore } from "./install-metrics";

/**
 * The failure this guards is silent: a dependency-install path that records
 * nothing, or records into the wrong instrument, looks identical to a healthy
 * one — nothing throws, the dashboard is just empty or wrong. Registering a
 * real SDK provider (no mocks) and reading the points back is the only way to
 * see the difference.
 */
describe("recordDepsRestore", () => {
  test("routes each source to its own instrument", async () => {
    const exporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE,
    );
    const provider = new MeterProvider({
      readers: [
        new PeriodicExportingMetricReader({
          exporter,
          // Long enough that only the explicit forceFlush below exports.
          exportIntervalMillis: 60_000,
        }),
      ],
    });
    metrics.setGlobalMeterProvider(provider);

    try {
      recordDepsRestore({
        source: "l1",
        cloneUrl: "https://user:token@github.com/acme/site.git",
        durationMs: 900,
      });
      recordDepsRestore({
        source: "miss",
        cloneUrl: "https://user:token@github.com/acme/site.git",
        durationMs: 42_000,
      });

      await provider.forceFlush();

      const byName = new Map(
        exporter
          .getMetrics()
          .flatMap((r) => r.scopeMetrics)
          .flatMap((s) => s.metrics)
          .map((m) => [m.descriptor.name, m]),
      );

      // Both outcomes counted, split by source.
      const restore = byName.get("studio.sandbox.deps.restore");
      expect(
        restore?.dataPoints.map((p) => [p.attributes.source, p.value]),
      ).toEqual([
        ["l1", 1],
        ["miss", 1],
      ]);

      // A miss times the install; a hit times the restore. Crossing these
      // would make L1 look as expensive as a cold install.
      const install = byName.get("studio.sandbox.deps.install_ms");
      const restoreMs = byName.get("studio.sandbox.deps.restore_ms");
      expect(install?.dataPoints[0]?.attributes.source).toBe("miss");
      expect(restoreMs?.dataPoints[0]?.attributes.source).toBe("l1");

      // Buckets must actually bracket the value. The SDK's defaults top out
      // at 10s, so a 42s install would land in +Inf and make every quantile
      // identical — the exact number this instrument exists to produce.
      const installPoint = install?.dataPoints[0]?.value as
        | { buckets: { boundaries: number[]; counts: number[] } }
        | undefined;
      const boundaries = installPoint?.buckets.boundaries ?? [];
      const overflow = installPoint?.buckets.counts.at(-1) ?? 0;
      expect(boundaries.at(-1)).toBeGreaterThan(42_000);
      expect(overflow).toBe(0);

      // Credentials in the clone URL must never reach the collector — the
      // label is the cache's own credential-stripped hash.
      const repoHashes = restore?.dataPoints.map((p) => p.attributes.repo_hash);
      expect(repoHashes?.every((h) => /^[0-9a-f]{16}$/.test(String(h)))).toBe(
        true,
      );
    } finally {
      // Bun shares one process across test files, so a provider left
      // registered here — worse, a shut-down one — would silently swallow
      // every metric recorded by any file that runs after this one.
      await provider.shutdown();
      metrics.disable();
    }
  });
});
