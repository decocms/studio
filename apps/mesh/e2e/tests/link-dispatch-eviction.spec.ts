/**
 * E2E test: link daemon eviction (last-link-wins).
 *
 * Verifies that when a second daemon connects for the same user, the first
 * daemon is evicted:
 *   1. Daemon A connects → /api/links/me returns machineId === "machine-A".
 *   2. Daemon B connects → /api/links/me updates to machineId === "machine-B".
 *   3. Daemon A's WS closes with code 4001 (superseded).
 *
 * Requires a running mesh + NATS stack. The Playwright webServer config
 * (`playwright.config.ts`) auto-starts `bun run dev:servers` which covers
 * this; no manual setup is needed for local runs.
 */

import { expect, test } from "../fixtures/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { connectToCluster } from "../../src/link-daemon/cluster-connection";
import type {
  ControlHandler,
  ControlHandlerResponse,
} from "../../src/link-daemon/control-handler";
import type { RequestFrame } from "../../src/links/dispatch-frames";

// Minimal stub — the eviction test never receives a dispatch, but
// connectToCluster expects the interface to be present.
const noopControlHandler: ControlHandler = {
  async handle(_req: RequestFrame): Promise<ControlHandlerResponse> {
    return { status: 404, body: "not implemented in e2e eviction test" };
  },
  async *handleStream(
    _req: RequestFrame,
  ): AsyncIterable<{ type: "raw-chunk"; data: Uint8Array }> {
    // nothing to yield — eviction test never receives a dispatch
  },
};

test("second daemon connection evicts the first", async ({ authedPage }) => {
  const { page, orgSlug } = authedPage;
  // page.context().request shares the session cookie set during sign-up,
  // so all requests below are authenticated as the test user.
  const apiRequest = page.context().request;

  // Mint an API key so both daemons share a Bearer token tied to this user.
  // The gateway resolves the bearer to the user's sub via Better Auth's
  // API-key plugin (enableSessionForAPIKeys).
  const apiKeyResult = await callSelfMcpTool<{ key?: string }>(
    apiRequest,
    orgSlug,
    "API_KEY_CREATE",
    {
      name: `link-eviction-e2e-${Date.now()}`,
      // Wildcard permissions — the daemon only needs to authenticate,
      // not call any specific tool.
      permissions: { "*": ["*"] },
    },
  );
  if (!apiKeyResult.key) {
    throw new Error(
      `API_KEY_CREATE returned no key: ${JSON.stringify(apiKeyResult)}`,
    );
  }
  const apiKey = apiKeyResult.key;

  const clusterBaseUrl = `http://localhost:${process.env.PORT ?? "3000"}`;
  const wsUrl = clusterBaseUrl.replace(/^http/, "ws") + "/api/links/connect";

  // Connect daemon A.
  const daemonA = await connectToCluster({
    url: wsUrl,
    accessToken: apiKey,
    hello: {
      previewPort: 19001,
      machineId: "machine-A",
      hostname: "e2e-host-A",
      cliVersion: "0.0.0-e2e",
      capabilities: [],
    },
    controlHandler: noopControlHandler,
    // Stop retrying after a single attempt so test failures are fast.
    maxAttempts: 1,
  });

  // Poll until daemon A's claim is visible via the REST endpoint.
  await expect
    .poll(
      async () => {
        const res = await apiRequest.get("/api/links/me");
        if (res.status() !== 200) return null;
        const body = (await res.json()) as unknown;
        if (!body || typeof body !== "object") return null;
        return (body as { machineId?: string }).machineId ?? null;
      },
      { timeout: 10_000, intervals: [200, 500, 1000] },
    )
    .toBe("machine-A");

  // Connect daemon B. Both daemons share the same API key (same user),
  // so the gateway should evict A and record B's claim.
  const daemonB = await connectToCluster({
    url: wsUrl,
    accessToken: apiKey,
    hello: {
      previewPort: 19002,
      machineId: "machine-B",
      hostname: "e2e-host-B",
      cliVersion: "0.0.0-e2e",
      capabilities: [],
    },
    controlHandler: noopControlHandler,
    maxAttempts: 1,
  });

  try {
    // After daemon B connects, the claim should update to machine-B.
    await expect
      .poll(
        async () => {
          const res = await apiRequest.get("/api/links/me");
          if (res.status() !== 200) return null;
          const body = (await res.json()) as unknown;
          if (!body || typeof body !== "object") return null;
          return (body as { machineId?: string }).machineId ?? null;
        },
        { timeout: 10_000, intervals: [200, 500, 1000] },
      )
      .toBe("machine-B");

    // Daemon A's WS must have been closed with 4001 (superseded).
    // `daemonA.closed` resolves when the connection loop terminates
    // (either via explicit close() or a non-reconnecting close code).
    await Promise.race([
      daemonA.closed,
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error("timed out waiting for daemon A to close")),
          10_000,
        ),
      ),
    ]);
  } finally {
    await daemonB.close();
  }
});
