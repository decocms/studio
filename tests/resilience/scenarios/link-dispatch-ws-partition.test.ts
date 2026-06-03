/**
 * Resilience scenario: sandbox↔studio WS partition.
 *
 * Drives a REAL link daemon + REAL spawned sandbox. Severs the daemon↔studio
 * WebSocket with Toxiproxy (clean TCP close) and asserts:
 *   1. The sandbox responds to a write/read round-trip while connected.
 *   2. While the WS is severed, the link goes offline (/api/links/me → null)
 *      and a tunneled read fails FAST (no hang, no queue/replay).
 *   3. After the WS is restored, the daemon reconnects (connectedAt advances)
 *      and the same read returns the same content (state preserved).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { registerTestHooks, testState } from "../lib/setup";
import { disableProxy, enableProxy } from "../lib/toxiproxy";
import { PROXY_NAMES } from "../lib/toxic-presets";
import { pollUntil } from "../lib/poll-until";
import {
  createAgent,
  getLinkClaim,
  getOrgSlug,
  sandboxPost,
  sandboxStart,
  startLinkDaemonContainer,
  stopLinkDaemonContainer,
  waitForLinkClaim,
} from "../lib/link-daemon-control";

registerTestHooks();

const BRANCH = "main";
const FILE_PATH = "resilience-marker.txt";
const FILE_CONTENT = "ws-partition-content";

let orgSlug = "";
let vmId = "";

describe("sandbox↔studio WS partition", () => {
  beforeAll(async () => {
    // setup's beforeAll already minted testState.apiKey/cookie/orgId.
    orgSlug = await getOrgSlug(testState.orgId, testState.cookie);
    vmId = await createAgent(
      testState.orgId,
      testState.cookie,
      "WS Partition Agent",
    );
    await startLinkDaemonContainer(testState.apiKey);
    await waitForLinkClaim(testState.cookie, 90_000);
    await sandboxStart(testState.orgId, testState.cookie, vmId, BRANCH);
  }, 180_000);

  afterAll(async () => {
    await stopLinkDaemonContainer();
  });

  test("write/read round-trip works while connected", async () => {
    const write = await sandboxPost(
      orgSlug,
      vmId,
      BRANCH,
      "/write",
      testState.cookie,
      { path: FILE_PATH, content: FILE_CONTENT },
    );
    expect(write.status).toBeLessThan(300);

    const read = await sandboxPost(
      orgSlug,
      vmId,
      BRANCH,
      "/read",
      testState.cookie,
      { path: FILE_PATH },
    );
    expect(read.status).toBe(200);
    const text = await read.text();
    expect(text).toContain(FILE_CONTENT);
  }, 60_000);

  test("WS severed → link offline + read fails fast (no queue/replay)", async () => {
    const before = await getLinkClaim(testState.cookie);
    expect(before).not.toBeNull();

    await disableProxy(PROXY_NAMES.STUDIO_WS);

    // The link claim is released once the gateway observes the WS close.
    await pollUntil(
      async () => (await getLinkClaim(testState.cookie)) === null,
      { timeoutMs: 30_000, intervalMs: 1_000, label: "link-offline" },
    );

    // A tunneled read must fail FAST (not hang). Offline → 404; in-flight
    // cut → 502 ws_closed. Either way: a non-2xx error, quickly.
    const start = performance.now();
    const read = await sandboxPost(
      orgSlug,
      vmId,
      BRANCH,
      "/read",
      testState.cookie,
      { path: FILE_PATH },
    );
    const durationMs = performance.now() - start;
    expect(read.status).toBeGreaterThanOrEqual(400);
    expect(durationMs).toBeLessThan(15_000);
  }, 90_000);

  test("WS restored → daemon reconnects and the sandbox responds again", async () => {
    // Capture whatever claim exists now as the baseline (afterEach from a prior
    // test may have re-enabled the proxy via resetAll; capture or fall back to 0).
    const baseline = await getLinkClaim(testState.cookie);
    const baselineConnectedAt = baseline?.connectedAt ?? 0;

    await enableProxy(PROXY_NAMES.STUDIO_WS);

    // Reconnect = a claim whose connectedAt advanced past the baseline.
    await pollUntil(
      async () => {
        const claim = await getLinkClaim(testState.cookie);
        return claim != null && claim.connectedAt > baselineConnectedAt;
      },
      { timeoutMs: 60_000, intervalMs: 1_000, label: "link-reconnect" },
    );

    // The same read now succeeds with preserved content (daemon process and
    // its file state survived the WS cut).
    await pollUntil(
      async () => {
        const read = await sandboxPost(
          orgSlug,
          vmId,
          BRANCH,
          "/read",
          testState.cookie,
          { path: FILE_PATH },
        );
        if (read.status !== 200) return false;
        const text = await read.text();
        return text.includes(FILE_CONTENT);
      },
      { timeoutMs: 60_000, intervalMs: 2_000, label: "read-after-reconnect" },
    );
  }, 150_000);
});
