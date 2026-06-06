/**
 * Establish pull-transport link presence for the authed user from a spec.
 *
 * A real desktop daemon holds an open long-poll on `GET /api/:org/links/work`;
 * the route synthetically mints a presence claim in the NATS KV bucket at the
 * start of the handler so `resolveDispatchTarget` sees the link as online (and
 * advertising the requested capabilities). Specs that previously brought a
 * WS link online via `connectToCluster` only to register presence (they never
 * await a dispatch) use this instead — it exercises the same code path a pull
 * daemon takes (Phase C-bis S6: the chat dispatch gate keys on a live
 * `user-desktop` target, which this claim produces).
 *
 * Usage:
 *   const presence = claimPullPresence(api, orgSlug, ["claude-code"]);
 *   try { ...assertions... } finally { await presence; }
 *
 * The returned promise resolves when the long-poll request settles (a 204 on
 * server timeout is fine — we only need the synchronous claim refresh). Await
 * it in a `finally` so the request doesn't outlive the test.
 */

import { expect, type APIRequestContext } from "@playwright/test";

export function claimPullPresence(
  api: APIRequestContext,
  orgSlug: string,
  capabilities: string[],
): Promise<unknown> {
  // Fire the long-poll with a short client timeout: just long enough for the
  // handler's synchronous claim refresh to land. 204/timeout is fine.
  const presencePromise = api
    .get(`/api/${orgSlug}/links/work`, {
      timeout: 1_500,
      headers: {
        "x-link-capabilities": capabilities.join(","),
        "x-link-machine-id": "e2e-test-machine",
        "x-link-cli-version": "test",
      },
    })
    .catch(() => null);

  // Poll until the claim is visible via /api/links/me before returning, so
  // callers can immediately POST /messages against an online link.
  return expect
    .poll(
      async () => {
        const res = await api.get("/api/links/me");
        if (res.status() !== 200) return null;
        return (await res.json()) as unknown;
      },
      { timeout: 10_000, intervals: [200, 500, 1_000] },
    )
    .not.toBeNull()
    .then(() => presencePromise);
}
