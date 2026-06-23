import { describe, expect, test } from "bun:test";
import { pollUntil } from "../lib/poll-until";
import { registerTestHooks } from "../lib/setup";
import { PROXY_NAMES } from "../lib/toxic-presets";
import { disableProxy, enableProxy } from "../lib/toxiproxy";

registerTestHooks();

describe("NATS outage", () => {
  test("health reports NATS status", async () => {
    // Check health when NATS is up
    const healthyRes = await fetch("http://127.0.0.1:13000/health/ready");
    const healthyData = (await healthyRes.json()) as any;
    console.log(
      `  → NATS status when up: ${healthyData.services?.nats?.status}`,
    );
    expect(healthyRes.ok).toBe(true);

    // Disable NATS
    await disableProxy(PROXY_NAMES.NATS);

    // Poll for NATS status change — give more time for reconnect detection
    await pollUntil(
      async () => {
        const res = await fetch("http://127.0.0.1:13000/health/ready");
        const health = (await res.json()) as any;
        const status = health.services?.nats?.status;
        if (status && status !== "up") {
          console.log(`  → NATS status changed to: ${status}`);
          return true;
        }
        return false;
      },
      { timeoutMs: 45_000, intervalMs: 2_000, label: "nats-health-down" },
    );

    // App should still be ready regardless
    const res = await fetch("http://127.0.0.1:13000/health/ready");
    expect(res.status).toBe(200);

    // Re-enable NATS
    await enableProxy(PROXY_NAMES.NATS);
  }, 60_000);
});
