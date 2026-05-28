/**
 * E2E test: link local ingress proxying.
 *
 * Verifies `startLocalIngress` inside the Playwright harness:
 *   1. Routes <handle>.localhost requests to the correct sandbox port.
 *   2. Returns 404 for unknown handles.
 *
 * These tests do NOT require a running cluster — `startLocalIngress` is an
 * in-process Bun.serve listener. No `authedPage` fixture is needed.
 *
 * Note: these scenarios are also covered by the unit tests in
 * `apps/mesh/src/link-daemon/local-ingress.test.ts`. The e2e variant
 * proves the same spec works inside the Playwright harness.
 */

import { test, expect } from "../fixtures/test";
import { startLocalIngress } from "../../src/link-daemon/local-ingress";

test("local ingress routes <handle>.localhost to sandbox", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch: () => new Response("hi", { status: 200 }),
  });
  const ingress = await startLocalIngress({
    port: 0,
    lookupSandboxPort: (h) => (h === "abc" ? upstream.port : null),
  });
  try {
    const res = await fetch(`http://127.0.0.1:${ingress.port}/`, {
      headers: { host: `abc.localhost:${ingress.port}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hi");
  } finally {
    await ingress.stop();
    upstream.stop(true);
  }
});

test("local ingress returns 404 for unknown handle", async () => {
  const ingress = await startLocalIngress({
    port: 0,
    lookupSandboxPort: () => null,
  });
  try {
    const res = await fetch(`http://127.0.0.1:${ingress.port}/`, {
      headers: { host: `nope.localhost:${ingress.port}` },
    });
    expect(res.status).toBe(404);
  } finally {
    await ingress.stop();
  }
});
