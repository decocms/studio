/**
 * E2E test: link WS gateway auth rejection.
 *
 * Verifies that the WS gateway rejects connections that have missing,
 * malformed, or unknown Bearer tokens at the HTTP upgrade step.
 *
 * These tests do NOT need a signed-in user or `authedPage` — they are
 * deliberately testing rejection paths before any authenticated flow begins.
 */

import { test, expect } from "../fixtures/test";

const wsUrl = (() => {
  const cluster = process.env.MESH_E2E_CLUSTER_URL ?? "http://localhost:3000";
  return cluster.replace(/^http/, "ws") + "/api/links/connect";
})();

async function openAndCaptureCloseCode(
  headers: Record<string, string> = {},
): Promise<number> {
  const ws = new WebSocket(wsUrl, { headers } as unknown as string);
  return new Promise<number>((resolve) => {
    ws.addEventListener("close", (e) => resolve(e.code));
    ws.addEventListener("error", () => {
      /* close event still fires; ignore */
    });
  });
}

test("WS upgrade without Authorization is rejected", async () => {
  const code = await openAndCaptureCloseCode();
  expect(code).not.toBe(1000);
});

test("WS upgrade with malformed bearer is rejected", async () => {
  const code = await openAndCaptureCloseCode({ authorization: "Bearer" });
  expect(code).not.toBe(1000);
});

test("WS upgrade with invalid bearer is rejected", async () => {
  const code = await openAndCaptureCloseCode({
    authorization: "Bearer not-a-real-token-zzz",
  });
  expect(code).not.toBe(1000);
});
