/**
 * Session rehoming — proves Better Auth session *invalidation* propagates
 * cluster-wide, not just creation.
 *
 * The cluster-smoke scenario already verifies a new session is visible on
 * all pods. This one closes the other half of the contract: signing out on
 * one pod must invalidate the cookie everywhere within a bounded window.
 * If that ever drifts (e.g. someone caches sessions in-memory per pod),
 * a signed-out user could still send requests through a different pod —
 * exactly the kind of bug that hides in single-pod tests.
 */

import { describe, expect, test } from "bun:test";
import { fetchOn, postJson } from "../lib/client";
import { registerTestHooks } from "../lib/hooks";
import { ALL_PODS, PODS } from "../lib/pods";
import { pollUntil } from "../lib/poll-until";
import { bootstrapSession } from "../lib/setup";

registerTestHooks();

interface SessionResponse {
  user?: { id?: string } | null;
}

async function getSessionUserId(
  pod: (typeof ALL_PODS)[number],
  cookie: string,
): Promise<string | undefined> {
  const res = await fetchOn(pod, "/api/auth/get-session", {
    auth: { cookie },
  });
  if (!res.ok) return undefined;
  const body = (await res.json()) as SessionResponse | null;
  return body?.user?.id;
}

describe("session rehoming", () => {
  test("sign-out on pod-2 invalidates the cookie on every pod", async () => {
    const session = await bootstrapSession(PODS.MESH_1);

    // Baseline: cookie is valid on all three pods. If this fails, the
    // smoke test would already have flagged it — but we want a fresh
    // baseline since this scenario creates its own session.
    for (const pod of ALL_PODS) {
      const userId = await getSessionUserId(pod, session.cookie);
      expect(userId).toBeTruthy();
    }

    // Sign out on a *different* pod than the one we signed up against.
    // That's the load-bearing assertion: the invalidation isn't local to
    // the pod that minted the session.
    await postJson(
      PODS.MESH_2,
      "/api/auth/sign-out",
      {},
      { auth: { cookie: session.cookie } },
    );

    // Better Auth deletes the session row synchronously, so a poll
    // shouldn't really be needed — but using pollUntil leaves room for
    // any future caching layer without rewriting the test, and surfaces
    // a clearer error message if a pod ever lags.
    for (const pod of ALL_PODS) {
      await pollUntil(
        async () => (await getSessionUserId(pod, session.cookie)) === undefined,
        {
          timeoutMs: 5_000,
          intervalMs: 250,
          label: `${pod.service}:cookie-invalidated`,
        },
      );
    }
  });
});
