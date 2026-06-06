/**
 * E2E smoke test: link daemon happy-path dispatch.
 *
 * Verifies the WS gateway end-to-end:
 *   1. Sign up a user and mint an API key (Bearer token for the daemon).
 *   2. Connect to the cluster WS gateway using `connectToCluster` directly —
 *      this exercises the full hello→claim flow without requiring the sandbox
 *      daemon binary (which is not available in the e2e harness).
 *   3. Poll GET /api/links/me (authenticated via session cookie from the
 *      fixture) and assert that the claim appears with a non-null previewPort
 *      within 10 s.
 *   4. Stop the connection and verify the claim is gone.
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

// Minimal stub — the smoke test never receives a dispatch, but
// connectToCluster expects the interface to be present.
const noopControlHandler: ControlHandler = {
  async handle(_req: RequestFrame): Promise<ControlHandlerResponse> {
    return { status: 404, body: "not implemented in e2e smoke test" };
  },
  async *handleStream(
    _req: RequestFrame,
  ): AsyncIterable<{ type: "raw-chunk"; data: Uint8Array }> {
    // nothing to yield — smoke test never receives a dispatch
  },
};

test("daemon connects and claim appears in /api/links/me", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  // page.context().request shares the session cookie set during sign-up,
  // so all requests below are authenticated as the test user.
  const apiRequest = page.context().request;

  // Mint an API key so the daemon has a Bearer token it can use to
  // authenticate against the WS gateway. The gateway calls
  // auth.api.getSession with the Bearer header; with enableSessionForAPIKeys
  // the Better Auth API-key plugin resolves it to the user's sub.
  const apiKeyResult = await callSelfMcpTool<{ key?: string }>(
    apiRequest,
    orgSlug,
    "API_KEY_CREATE",
    {
      name: `link-e2e-${Date.now()}`,
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

  // A fake but valid preview port — the smoke test only checks that the
  // claim appears; it does not actually proxy traffic through ingress.
  const fakePreviewPort = 19999;

  const cluster = await connectToCluster({
    url: wsUrl,
    accessToken: apiKey,
    hello: {
      previewPort: fakePreviewPort,
      machineId: "e2e-test-machine",
      hostname: "e2e-test-host",
      cliVersion: "0.0.0-e2e",
      capabilities: [],
    },
    controlHandler: noopControlHandler,
    // Stop retrying after a single attempt so test failures are fast.
    maxAttempts: 1,
  });

  try {
    // Poll until the claim is visible via the REST endpoint. The gateway
    // writes to the NATS KV bucket synchronously during hello handling, so
    // this should resolve in milliseconds — 10 s timeout is generous.
    await expect
      .poll(
        async () => {
          const res = await apiRequest.get("/api/links/me");
          if (res.status() !== 200) return null;
          const body = (await res.json()) as unknown;
          if (!body || typeof body !== "object") return null;
          return body;
        },
        { timeout: 10_000, intervals: [200, 500, 1000] },
      )
      .toMatchObject({ previewPort: fakePreviewPort });
  } finally {
    await cluster.close();
  }

  // After stopping, the gateway's close handler deletes the claim from the
  // registry. Allow a brief window for propagation.
  await expect
    .poll(
      async () => {
        const res = await apiRequest.get("/api/links/me");
        if (res.status() !== 200) return "not-200";
        const body = (await res.json()) as unknown;
        // Gateway returns null JSON when no claim exists.
        return body;
      },
      { timeout: 5_000, intervals: [200, 500] },
    )
    .toBeNull();
});
