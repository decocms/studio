/**
 * The TS twin of daemon-go's TestInitExportsToEndpoint. Runs a real OTLP/HTTP
 * receiver on localhost and asserts the daemon's three instruments arrive with
 * the names, units and attributes the Go daemon uses — the export path is what
 * silently breaks (a resource merge failure, a wrong content type, a histogram
 * the collector rejects), and none of it shows up in a type check.
 */

import { afterEach, expect, test } from "bun:test";
import { initTelemetry, recordDepsRestore, recordPhase } from "./telemetry";

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
    await shutdown();

    const payload = bodies.join("");
    expect(payload).toContain("sandbox.daemon.phase.duration");
    expect(payload).toContain("sandbox.daemon.deps.restore");
    expect(payload).toContain("sandbox.daemon.deps.restore.duration");
    // The comparison dimension: without it a panel cannot split ts from go.
    expect(payload).toContain("daemon.impl");
    expect(payload).toContain("studio-sandbox-daemon");
    expect(payload).toContain("install");
    expect(payload).toContain("l1");
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
