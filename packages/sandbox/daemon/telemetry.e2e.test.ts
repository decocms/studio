/**
 * The TS twin of daemon-go's TestInitExportsToEndpoint. Runs a real OTLP/HTTP
 * receiver on localhost and asserts the daemon's instruments arrive with the
 * names, units, buckets and attributes the Go daemon uses — the export path is what
 * silently breaks (a resource merge failure, a wrong content type, a histogram
 * the collector rejects), and none of it shows up in a type check.
 */

import { afterEach, expect, test } from "bun:test";
import { sleep } from "@decocms/shared/std";
import {
  initTelemetry,
  recordDepsRestore,
  recordDevServerExit,
  recordPhase,
  recordProxy,
  recordPublish,
  recordReady,
} from "./telemetry";

const originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const originalInterval = process.env.OTEL_METRIC_EXPORT_INTERVAL;

afterEach(() => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
  process.env.OTEL_METRIC_EXPORT_INTERVAL = originalInterval;
});

test("exports the daemon instruments to an OTLP endpoint", async () => {
  const bodies: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      bodies.push(await req.text());
      return new Response("{}", {
        headers: { "content-type": "application/json" },
      });
    },
  });

  try {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://localhost:${server.port}`;
    // Long enough that only the shutdown flush can produce the export, which is
    // the path a short-lived sandbox actually takes.
    process.env.OTEL_METRIC_EXPORT_INTERVAL = "600000";

    const shutdown = initTelemetry("boot-test", "ts");
    recordPhase("install", "done", 1234);
    recordDepsRestore("l1", 42);
    recordReady(9876);
    recordProxy(12, "2xx");
    recordDevServerExit(false);
    recordPublish("done", 345);
    await shutdown();

    const payload = bodies.join("");
    for (const name of [
      "sandbox.daemon.phase.duration",
      "sandbox.daemon.deps.restore",
      "sandbox.daemon.deps.restore.duration",
      "sandbox.daemon.ready.duration",
      "sandbox.daemon.proxy.duration",
      "sandbox.daemon.devserver.exit",
      "sandbox.daemon.publish.duration",
    ]) {
      expect(payload).toContain(name);
    }
    // The comparison dimension: without it a panel cannot split ts from go.
    expect(payload).toContain("daemon.impl");
    expect(payload).toContain("studio-sandbox-daemon");
    expect(payload).toContain("install");
    expect(payload).toContain("l1");
  } finally {
    server.stop(true);
  }
});

test("duration histograms carry buckets that reach past a slow boot", async () => {
  const bodies: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      bodies.push(await req.text());
      return new Response("{}", {
        headers: { "content-type": "application/json" },
      });
    },
  });

  try {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://localhost:${server.port}`;
    process.env.OTEL_METRIC_EXPORT_INTERVAL = "600000";

    const shutdown = initTelemetry("boot-test", "ts");
    recordPhase("install", "done", 45_000);
    await shutdown();

    const phase = JSON.parse(
      bodies.join(""),
    ).resourceMetrics[0].scopeMetrics[0].metrics.find(
      (m: { name: string }) => m.name === "sandbox.daemon.phase.duration",
    ).histogram.dataPoints[0];
    // The OTel default set stops at 10s, which would bucket a 45s install into
    // +Inf together with every other slow boot — and a percentile computed from
    // that is fiction. These bounds are shared verbatim with daemon-go so the
    // two impls' panels are comparable at all.
    expect(phase.explicitBounds).toContain(300_000);
    expect(phase.bucketCounts.at(-1)).toBe(0);
  } finally {
    server.stop(true);
  }
});

test("samples loop lag on its own timer", async () => {
  const bodies: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      bodies.push(await req.text());
      return new Response("{}", {
        headers: { "content-type": "application/json" },
      });
    },
  });

  try {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://localhost:${server.port}`;
    process.env.OTEL_METRIC_EXPORT_INTERVAL = "600000";

    const shutdown = initTelemetry("boot-test", "ts");
    // Nothing records lag explicitly — the sampler is the only producer, so
    // this also proves it was started and survives to the flush. One tick plus
    // slack; the sampler's interval is 1s.
    await sleep(1_200);
    await shutdown();

    const lag = JSON.parse(
      bodies.join(""),
    ).resourceMetrics[0].scopeMetrics[0].metrics.find(
      (m: { name: string }) => m.name === "sandbox.daemon.loop.lag",
    )?.histogram.dataPoints[0];
    expect(lag.count).toBeGreaterThan(0);
    // Lag has its own bucket set — the duration bounds would put every healthy
    // sample in the first bucket and say nothing.
    expect(lag.explicitBounds).toContain(1);
  } finally {
    server.stop(true);
  }
});

test("is a no-op with no endpoint configured", async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "";
  const shutdown = initTelemetry("boot-test", "ts");
  // Recording against an uninitialised pipeline must not throw — every call
  // site is on the boot path.
  recordPhase("clone", "failed", 1);
  recordDepsRestore("miss", 1);
  await shutdown();
});
