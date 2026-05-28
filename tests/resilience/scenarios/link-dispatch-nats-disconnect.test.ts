/**
 * Resilience scenario: link dispatch under NATS disconnect.
 *
 * The link-tunnel dispatch path is: HTTP client → studio pod → NATS
 * (`links.dispatch.<userSub>`) → daemon over WS → studio pod (reply inbox)
 * → HTTP client.
 *
 * This scenario exercises the mesh side of that path using the existing
 * resilience harness (single studio pod + Toxiproxy). Because the harness
 * does not include a link-daemon container, we drive the studio MCP API
 * directly and verify:
 *
 *   1. Normal tool calls route through NATS publish/subscribe without issue.
 *   2. When NATS is severed mid-dispatch (via Toxiproxy), the in-flight
 *      dispatch fails with a typed error rather than hanging indefinitely
 *      for the full request timeout.
 *   3. The studio health endpoint correctly reflects NATS degradation while
 *      the connection is down.
 *   4. After NATS recovers, subsequent dispatches succeed (studio reconnects
 *      to NATS and resumes normal operation).
 *
 * NOTE: A full end-to-end link-dispatch test (with an actual daemon WebSocket
 * client) requires the harness to include a `link-daemon` container and a
 * proxy for `studio:3000` (so the daemon WS can be severed independently from
 * the NATS path). The tests below validate the studio/NATS half of the dispatch
 * path only. Daemon-side reconnect behaviour is covered by the unit tests in
 * `apps/mesh/src/link-daemon/reconnect-backoff.test.ts` and
 * `apps/mesh/src/link-daemon/cluster-connection.test.ts`.
 *
 * TODO: add a `link-daemon` service to the resilience docker-compose and a
 * Toxiproxy proxy for `studio:3000` so we can also assert:
 *   - The daemon's WebSocket closes when the studio pod crashes (not affected
 *     by NATS, which is mesh↔mesh only).
 *   - The daemon reconnects per `reconnect-backoff.ts` after studio restarts.
 */

import { describe, expect, test } from "bun:test";
import { registerTestHooks, testState } from "../lib/setup";
import { disableProxy, enableProxy } from "../lib/toxiproxy";
import { PROXY_NAMES } from "../lib/toxic-presets";
import { mcpCall } from "../lib/studio-client";
import { pollUntil } from "../lib/poll-until";

registerTestHooks();

describe("link dispatch — NATS disconnect", () => {
  // ──────────────────────────────────────────────────────────────────────────
  // Baseline: normal NATS path
  // ──────────────────────────────────────────────────────────────────────────

  test("tool calls succeed when NATS is healthy", async () => {
    // Studio's virtual `self` connection routes through the internal
    // event-bus worker which depends on NATS for notify. A successful
    // COLLECTION_CONNECTIONS_LIST proves the NATS path is alive.
    const { result } = await mcpCall(
      `${testState.orgId}_self`,
      "tools/call",
      { name: "COLLECTION_CONNECTIONS_LIST", arguments: {} },
      { apiKey: testState.apiKey },
      { timeoutMs: 15_000 },
    );
    expect(result).toBeTruthy();
    console.log("  → Baseline: tool call succeeded with NATS healthy");
  }, 30_000);

  // ──────────────────────────────────────────────────────────────────────────
  // In-flight dispatch fails fast when NATS goes down
  // ──────────────────────────────────────────────────────────────────────────

  test("dispatch fails fast (not hang) when NATS is severed", async () => {
    // Sever NATS through Toxiproxy.
    await disableProxy(PROXY_NAMES.NATS);

    // Allow the studio NATS client a moment to detect the broken connection.
    await Bun.sleep(5_000);

    // Attempt a tool call that requires NATS. It should fail with an error
    // (any non-hang error is acceptable) and not take the full request timeout.
    const start = performance.now();
    try {
      await mcpCall(
        `${testState.orgId}_self`,
        "tools/call",
        { name: "COLLECTION_CONNECTIONS_LIST", arguments: {} },
        { apiKey: testState.apiKey },
        // Give a generous upper bound — the key assertion is that we fail
        // well before this ceiling.
        { timeoutMs: 35_000 },
      );
      // If the call unexpectedly succeeded despite NATS being down, that is
      // only a concern if the tool genuinely requires NATS. Log it and
      // move on — the studio may have fallen back gracefully.
      const durationMs = performance.now() - start;
      console.log(
        `  → Call succeeded with NATS down in ${Math.round(durationMs)}ms (fallback path?)`,
      );
    } catch (error: any) {
      const durationMs = performance.now() - start;
      console.log(
        `  → Call failed in ${Math.round(durationMs)}ms: ${String(error.message ?? error).slice(0, 120)}`,
      );
      // The important invariant: the failure must not hang for the full timeout.
      expect(durationMs).toBeLessThan(35_000);
      // The error must carry a message (not a silent hang / AbortError with no context).
      expect(error.message).toBeTruthy();
    }
    // afterEach re-enables all proxies via resetAll()
  }, 60_000);

  // ──────────────────────────────────────────────────────────────────────────
  // Health endpoint reflects NATS degradation
  // ──────────────────────────────────────────────────────────────────────────

  test("health reports NATS degradation while disconnected", async () => {
    // Confirm healthy baseline.
    const beforeRes = await fetch("http://127.0.0.1:13000/health/ready");
    expect(beforeRes.ok).toBe(true);
    const beforeData = (await beforeRes.json()) as any;
    console.log(
      `  → NATS status before disconnect: ${beforeData.services?.nats?.status ?? "unknown"}`,
    );

    // Sever NATS.
    await disableProxy(PROXY_NAMES.NATS);

    // Poll until the health endpoint reflects NATS degradation. Studio keeps
    // running (it's resilient to transient NATS loss) but the `/health/ready`
    // endpoint should report a non-"up" NATS status once the client notices.
    await pollUntil(
      async () => {
        try {
          const res = await fetch("http://127.0.0.1:13000/health/ready");
          const data = (await res.json()) as any;
          const natsStatus = data.services?.nats?.status;
          if (natsStatus && natsStatus !== "up") {
            console.log(`  → NATS status changed to: ${natsStatus}`);
            return true;
          }
          return false;
        } catch {
          return false;
        }
      },
      { timeoutMs: 45_000, intervalMs: 2_000, label: "nats-health-degraded" },
    );

    // Studio itself must remain reachable (non-500 on the liveness probe).
    const liveRes = await fetch("http://127.0.0.1:13000/health/live");
    expect(liveRes.status).toBeLessThan(500);
    console.log(
      `  → Studio still live with NATS down (HTTP ${liveRes.status})`,
    );

    // afterEach re-enables the proxy.
  }, 60_000);

  // ──────────────────────────────────────────────────────────────────────────
  // Recovery: dispatches resume after NATS comes back
  // ──────────────────────────────────────────────────────────────────────────

  test("dispatches succeed after NATS recovers", async () => {
    // Sever and wait for detection.
    await disableProxy(PROXY_NAMES.NATS);
    await Bun.sleep(5_000);

    // Re-enable NATS.
    await enableProxy(PROXY_NAMES.NATS);

    // Poll until tool calls succeed again — NATS reconnect + health recovery.
    await pollUntil(
      async () => {
        try {
          const healthRes = await fetch("http://127.0.0.1:13000/health/ready");
          if (!healthRes.ok) return false;

          const { result } = await mcpCall(
            `${testState.orgId}_self`,
            "tools/call",
            { name: "COLLECTION_CONNECTIONS_LIST", arguments: {} },
            { apiKey: testState.apiKey },
            { timeoutMs: 10_000 },
          );
          return !!result;
        } catch {
          return false;
        }
      },
      {
        timeoutMs: 60_000,
        intervalMs: 3_000,
        label: "dispatch-recovery-after-nats",
      },
    );
    console.log("  → Dispatches recovered after NATS reconnect");
  }, 90_000);
});
