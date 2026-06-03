/**
 * Resilience scenario: sandbox log/event SSE replay across a WS reconnect.
 *
 * The daemon keeps a per-source ReplayBuffer (256 KB/source). Output of a
 * named `exec` script lands in it under source=<script>. Because the daemon
 * PROCESS survives a studio_ws Toxiproxy cut (only the WS is severed), the
 * buffer is retained, so a reconnecting `/events` SSE replays the marker.
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
  parseSseLogFrames,
  readEventsSnapshot,
  sandboxPost,
  sandboxPutConfig,
  sandboxStart,
  startLinkDaemonContainer,
  stopLinkDaemonContainer,
  waitForLinkClaim,
} from "../lib/link-daemon-control";

registerTestHooks();

const BRANCH = "main";
const MARKER = `MARKER-${testState.orgId || "x"}-${process.pid}`;

let orgSlug = "";
let vmId = "";

describe("sandbox log/event SSE replay", () => {
  beforeAll(async () => {
    orgSlug = await getOrgSlug(testState.orgId, testState.cookie);
    vmId = await createAgent(
      testState.orgId,
      testState.cookie,
      "Log Replay Agent",
    );
    await startLinkDaemonContainer(testState.apiKey);
    await waitForLinkClaim(testState.cookie, 90_000);
    await sandboxStart(testState.orgId, testState.cookie, vmId, BRANCH);

    // Configure exec: a packageManager + a package.json with a `marker` script.
    await sandboxPost(orgSlug, vmId, BRANCH, "/write", testState.cookie, {
      path: "package.json",
      content: JSON.stringify({
        name: "resilience-fixture",
        packageManager: "npm@10.0.0",
        scripts: { marker: `echo ${MARKER}` },
      }),
    });
    await sandboxPutConfig(orgSlug, vmId, BRANCH, testState.cookie, {
      application: { packageManager: "npm" },
    });
  }, 180_000);

  afterAll(async () => {
    await stopLinkDaemonContainer();
  });

  test("marker appears in the events replay snapshot", async () => {
    // Emit the marker into the ReplayBuffer via a named exec script.
    const exec = await sandboxPost(
      orgSlug,
      vmId,
      BRANCH,
      "/exec/marker",
      testState.cookie,
      {},
    );
    expect(exec.status).toBeLessThan(400);

    await pollUntil(
      async () => {
        const raw = await readEventsSnapshot(
          orgSlug,
          vmId,
          BRANCH,
          testState.cookie,
        );
        return parseSseLogFrames(raw).some((f) => f.data.includes(MARKER));
      },
      { timeoutMs: 30_000, intervalMs: 2_000, label: "marker-in-snapshot" },
    );
  }, 90_000);

  test("marker still replays after a WS drop + reconnect", async () => {
    const baseline = await getLinkClaim(testState.cookie);
    const baselineConnectedAt = baseline?.connectedAt ?? 0;

    await disableProxy(PROXY_NAMES.STUDIO_WS);
    await pollUntil(
      async () => (await getLinkClaim(testState.cookie)) === null,
      { timeoutMs: 30_000, intervalMs: 1_000, label: "link-offline" },
    );
    await enableProxy(PROXY_NAMES.STUDIO_WS);
    await pollUntil(
      async () => {
        const claim = await getLinkClaim(testState.cookie);
        return claim != null && claim.connectedAt > baselineConnectedAt;
      },
      { timeoutMs: 60_000, intervalMs: 1_000, label: "link-reconnect" },
    );

    // The daemon process survived → its ReplayBuffer still has the marker.
    await pollUntil(
      async () => {
        const raw = await readEventsSnapshot(
          orgSlug,
          vmId,
          BRANCH,
          testState.cookie,
        );
        return parseSseLogFrames(raw).some((f) => f.data.includes(MARKER));
      },
      {
        timeoutMs: 60_000,
        intervalMs: 2_000,
        label: "marker-replayed-after-reconnect",
      },
    );
  }, 180_000);
});
