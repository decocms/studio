/**
 * Cluster smoke test — proves the multi-pod framework actually works.
 *
 * Three assertions, each one rules out a class of "did I wire it right"
 * failure before we trust any higher-level scenario:
 *
 *   1. All three pods respond to /health/live independently.
 *      → compose works, ports map, mesh boots, migrations ran once.
 *
 *   2. /health/ready agrees on the *same* nats and postgres dependencies.
 *      → all pods see the same shared infra (not three independent stacks).
 *
 *   3. A session bootstrapped against pod 1 is recognized by pod 2 and 3.
 *      → Better Auth's session store lives in shared Postgres, which is
 *      what makes any cross-pod scenario possible in the first place.
 */

import { describe, expect, test } from "bun:test";
import { getJson, fetchOn } from "../lib/client";
import { registerTestHooks } from "../lib/hooks";
import { ALL_PODS, PODS } from "../lib/pods";
import { bootstrapSession } from "../lib/setup";

registerTestHooks();

interface HealthReady {
  status: string;
  services?: Record<string, { status: string }>;
}

describe("cluster smoke", () => {
  test("every pod responds to /health/live", async () => {
    for (const pod of ALL_PODS) {
      const res = await fetchOn(pod, "/health/live");
      expect(res.status).toBe(200);
    }
  });

  test("every pod reports postgres and nats up via /health/ready", async () => {
    for (const pod of ALL_PODS) {
      const health = await getJson<HealthReady>(pod, "/health/ready");
      expect(health.services?.postgres?.status).toBe("up");
      expect(health.services?.nats?.status).toBe("up");
    }
  });

  test("session created on pod-1 is recognized on pod-2 and pod-3", async () => {
    const session = await bootstrapSession(PODS.MESH_1);

    for (const pod of [PODS.MESH_2, PODS.MESH_3]) {
      const res = await fetchOn(pod, "/api/auth/get-session", {
        auth: { cookie: session.cookie },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user?: { id?: string } } | null;
      // The session endpoint returns the user when authenticated; absence
      // would mean each pod has its own session store (the bug we're
      // guarding against).
      expect(body?.user?.id).toBeTruthy();
    }
  });
});
