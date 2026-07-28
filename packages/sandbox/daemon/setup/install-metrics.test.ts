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

    // A miss times the install; a hit times the restore. Crossing these would
    // make L1 look as expensive as a cold install.
    expect(
      byName.get("studio.sandbox.deps.install_ms")?.dataPoints[0]?.attributes
        .source,
    ).toBe("miss");
    expect(
      byName.get("studio.sandbox.deps.restore_ms")?.dataPoints[0]?.attributes
        .source,
    ).toBe("l1");

    // Credentials in the clone URL must never reach the collector — the label
    // is the cache's own credential-stripped hash.
    const repoHashes = restore?.dataPoints.map((p) => p.attributes.repo_hash);
    expect(repoHashes?.every((h) => /^[0-9a-f]{16}$/.test(String(h)))).toBe(
      true,
    );

    await provider.shutdown();
  });
});
