/**
 * Graceful-shutdown recovery scenario.
 *
 * SIGTERM mid-stream must trigger the same recovery path as SIGKILL.
 * Earlier the heartbeat `stop()` DELETEd the pod's `studio_pods` row
 * before ending the liveness connection, so survivors' polls saw the
 * row gone, never probed the lock, never fired `handlePodDeath`, and
 * `runRegistry.stopAll()` nulled `run_owner_pod` for our runs — leaving
 * the orphan signal lost. This test rebuilds the same kill scenario as
 * `pod-death-dbos-replay` but with SIGTERM so a regression on that
 * graceful-shutdown path fails here loudly.
 *
 * ── What the test exercises ──────────────────────────────────────────
 *
 *   1. POST a SLOW message; wait for chunk-2 (run is flowing).
 *   2. Read `threads.run_owner_pod` and SIGTERM that pod.
 *   3. Wait for a chunk whose mock-ai call-start timestamp is *after*
 *      the stop — same deterministic timestamp gate as the SIGKILL
 *      scenario. A chunk with `t > stopTime` can only come from the
 *      resumed pump on a survivor.
 *
 * The shutdown handler runs `runRegistry.stopAll()` first (aborting
 * in-flight dispatch + clearing in-memory state, but LEAVING
 * `run_owner_pod` set) and then `podHeartbeat.stop()` (releasing the
 * advisory lock without touching `studio_pods`). Survivors' next poll
 * tick — within `POLL_INTERVAL_MS = 5s` — sees the lock free, deletes
 * the row, and calls `handlePodDeath`, which finds the stopped pod's
 * orphans by `run_owner_pod = stoppedPodId` and resumes them.
 */

import { describe, expect, test } from "bun:test";
import { postJson, sse } from "../lib/client";
import { getThreadRunOwnerPod } from "../lib/db";
import { registerTestHooks } from "../lib/hooks";
import { stop } from "../lib/pod";
import type { PodInfo, PodName } from "../lib/pods";
import { ALL_PODS, PODS } from "../lib/pods";
import { pollUntil } from "../lib/poll-until";
import {
  bootstrapSession,
  createTestAgent,
  createTestThread,
  wireMockProvider,
} from "../lib/setup";

registerTestHooks();

const MOCK_HINT = "slow:20x500"; // ~10s

interface Watcher {
  pod: PodInfo;
  joined: string;
  abort: AbortController;
  done: Promise<void>;
}

function openAttachWatcher(
  pod: PodInfo,
  orgSlug: string,
  threadId: string,
  apiKey: string,
): Watcher {
  const abort = new AbortController();
  const watcher: Watcher = {
    pod,
    joined: "",
    abort,
    done: Promise.resolve(),
  };

  watcher.done = (async () => {
    try {
      for await (const payload of sse(
        pod,
        `/api/${orgSlug}/decopilot/threads/${threadId}/stream`,
        { auth: { apiKey }, signal: abort.signal },
      )) {
        watcher.joined += payload;
      }
    } catch (err) {
      const code = (err as { code?: string } | null)?.code ?? "";
      const msg = err instanceof Error ? err.message : String(err);
      const expectedCodes = ["ECONNRESET", "ECONNREFUSED", "ABORT_ERR"];
      const expectedMsgs = [
        "aborted",
        "ECONNRESET",
        "ECONNREFUSED",
        "fetch failed",
        "socket connection was closed",
      ];
      const expected =
        expectedCodes.includes(code) ||
        expectedMsgs.some((needle) => msg.includes(needle));
      if (!expected) throw err;
    }
  })();

  return watcher;
}

describe("graceful-shutdown recovery", () => {
  test("SIGTERM on the owning pod still delivers chunks via a survivor", async () => {
    const session = await bootstrapSession(PODS.MESH_1);
    await wireMockProvider(PODS.MESH_1, session);
    const { virtualMcpId } = await createTestAgent(PODS.MESH_1, session);
    const { threadId } = await createTestThread(
      PODS.MESH_1,
      session,
      virtualMcpId,
    );

    const messageBody = {
      messages: [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: MOCK_HINT }],
        },
      ],
      agent: { id: virtualMcpId },
      tier: "smart",
    };
    const postRes = await postJson(
      PODS.MESH_1,
      `/api/${session.orgSlug}/decopilot/threads/${threadId}/messages`,
      messageBody,
      { auth: { apiKey: session.apiKey } },
    );
    expect(postRes.status).toBe(202);

    const watchers = ALL_PODS.map((pod) =>
      openAttachWatcher(pod, session.orgSlug, threadId, session.apiKey),
    );

    await pollUntil(
      async () => watchers.some((w) => w.joined.includes("chunk-2")),
      {
        timeoutMs: 15_000,
        intervalMs: 200,
        label: "run-flowing-before-stop",
      },
    );

    const ownerRaw = await pollUntil(
      async () => (await getThreadRunOwnerPod(threadId)) !== null,
      { timeoutMs: 5_000, intervalMs: 200, label: "owner-pod-claimed" },
    )
      .then(() => getThreadRunOwnerPod(threadId))
      .then((v) => v as PodName);
    expect(["mesh-1", "mesh-2", "mesh-3"]).toContain(ownerRaw);

    console.log(`  → run owned by ${ownerRaw}; SIGTERMing it`);
    const stopTime = Date.now();
    await stop(ownerRaw);

    const survivors = watchers.filter((w) => w.pod.service !== ownerRaw);

    try {
      // Deterministic gate: a chunk with `t > stopTime` provably comes
      // from a mock-ai call started after we asked the owner to stop,
      // i.e. the resumed pump on a survivor. Without the graceful-
      // shutdown fix, the survivor never detects the death (registry
      // row is gone, no probe target) and no such chunk arrives.
      await pollUntil(
        async () =>
          survivors.some((w) => {
            for (const m of w.joined.matchAll(/t(\d+) chunk-/g)) {
              if (Number(m[1]) > stopTime) return true;
            }
            return false;
          }),
        {
          // Worst case: full POLL_INTERVAL_MS (5s) for the next
          // survivor poll + handlePodDeath claim + dispatch boot. 75s
          // matches the SIGKILL scenario's tolerance.
          timeoutMs: 75_000,
          intervalMs: 500,
          label: "resumed-pump-flowing",
        },
      );

      await pollUntil(
        async () => survivors.some((w) => w.joined.includes("chunk-20")),
        {
          timeoutMs: 90_000,
          intervalMs: 500,
          label: "final-chunk-after-replay",
        },
      );
    } finally {
      for (const w of watchers) w.abort.abort();
      await Promise.allSettled(watchers.map((w) => w.done));
    }
  }, 220_000);
});
