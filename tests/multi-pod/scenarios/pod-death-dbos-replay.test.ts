/**
 * Pod-death recovery via DBOS workflow replay.
 *
 * Validates the simplification: heartbeat + cross-pod claim CAS were
 * deleted in favor of trusting DBOS launch-time recovery. The contract
 * being verified here is exactly DBOS's documented one — "When an
 * application with an executor ID restarts, it only recovers pending
 * workflows assigned to that executor ID" — under our actual streaming
 * pipeline (threadGateWorkflow → dispatchRunAndWaitStep → streamText
 * → JetStream pump).
 *
 * ── What the test exercises ──────────────────────────────────────────
 *
 *   1. POST a SLOW message (20 chunks × 500ms ≈ 10s).
 *   2. Open /stream on all three pods.
 *   3. Wait for chunk-2 — proof the run is flowing.
 *   4. Read `threads.run_owner_pod` and SIGKILL that pod.
 *   5. Restart the killed pod with `docker compose start <name>` —
 *      mimics K8s StatefulSet bringing the pod back with the same
 *      identity (POD_NAME → DBOS executor_id).
 *   6. DBOS launches on the restarted pod, sees its own PENDING
 *      threadGateWorkflow in `dbos.workflow_status`, and re-runs the
 *      `dispatchRunAndWaitStep` from scratch — streamText fires again
 *      against the mock-ai, chunks land on the same per-thread
 *      JetStream subject, and SSE tails on any pod see them.
 *   7. Wait for a chunk whose mock-ai call-start timestamp is *after*
 *      the kill — proves the chunks came from the replayed step, not
 *      from the dead pod's leftover JetStream prefix.
 *   8. Wait for chunk-20 to confirm the replay completes end-to-end.
 *   9. Open a late /stream AFTER the resumed pump is flowing and
 *      assert chunks 1..20 appear EXACTLY ONCE (`chunk-1 ` count == 1).
 *      If `prepareRun`'s JetStream purge ever regresses, this watcher
 *      would see the dead pod's prefix AND the resumed run, doubling
 *      the count.
 *
 * ── What enables this ────────────────────────────────────────────────
 *
 *   - **DBOS executorID = POD_NAME** (`apps/mesh/src/index.ts`):
 *     pins this pod's workflows to a stable id that K8s StatefulSet
 *     preserves across restarts. Without this, every restart would be
 *     a "new executor" and orphans would sit forever.
 *
 *   - **Single `dispatchRunAndWaitStep` per thread-gate workflow**
 *     (`apps/mesh/src/dispatch-queue/thread-gate-workflow.ts`): the
 *     entire streamText loop is one DBOS step, so replay re-runs the
 *     whole agent turn (correct as long as steps are idempotent, which
 *     they are for our LLM calls).
 *
 *   - **Unconditional awaited `streamBuffer.purge` in prepareRun**
 *     (`apps/mesh/src/api/routes/decopilot/dispatch-run.ts`): replay
 *     would otherwise pump on top of the dead pod's leftover prefix in
 *     JetStream, and any /stream opened post-recovery would see the
 *     response duplicated. The chunk-1 count assertion below is the
 *     regression guard.
 *
 *   - **Stable mock-ai per-call timestamp** (`tests/multi-pod/mock-ai/
 *     server.ts`): every chunk emits `t<ms>` for the wall-clock moment
 *     the mock-ai call began. A chunk with `t > killTime` provably
 *     came from a call started after the kill — i.e. the replay.
 */

import { describe, expect, test } from "bun:test";
import { postJson, sse } from "../lib/client";
import { getThreadRunOwnerPod } from "../lib/db";
import { registerTestHooks } from "../lib/hooks";
import { kill, start } from "../lib/pod";
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

const MOCK_HINT = "slow:20x500"; // ~10s — plenty of time for kill + replay

interface Watcher {
  pod: PodInfo;
  /** Joined SSE payloads observed so far. */
  joined: string;
  abort: AbortController;
  /** Resolves when the consumer loop ends (SSE closed, aborted, error). */
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
      // Aborts and connection drops (when the owning pod dies) are
      // expected in this scenario — swallow them. Anything else
      // re-throws so the test sees it.
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

describe("pod-death + DBOS replay", () => {
  test("killing the owning pod mid-stream still delivers the final chunk via DBOS replay on restart", async () => {
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
        label: "run-flowing-before-kill",
      },
    );

    const ownerRaw = await pollUntil(
      async () => (await getThreadRunOwnerPod(threadId)) !== null,
      { timeoutMs: 5_000, intervalMs: 200, label: "owner-pod-claimed" },
    )
      .then(() => getThreadRunOwnerPod(threadId))
      .then((v) => v as PodName);
    expect(["mesh-1", "mesh-2", "mesh-3"]).toContain(ownerRaw);

    console.log(`  → run owned by ${ownerRaw}; SIGKILLing then restarting it`);
    const killTime = Date.now();
    await kill(ownerRaw);

    // Bring the same pod back up (StatefulSet-style identity). DBOS
    // launch-time recovery on this pod scans its workflow_status rows
    // for executor_id = POD_NAME with status PENDING and replays them.
    await start(ownerRaw);

    const otherWatchers = watchers.filter((w) => w.pod.service !== ownerRaw);
    let lateWatcher: Watcher | null = null;
    try {
      // Deterministic gate: a chunk with `t > killTime` came from a
      // mock-ai call started AFTER the kill, which can only be the
      // DBOS-replayed dispatchRunAndWaitStep on the restarted pod.
      // Window covers: pod restart (~30s for clean reboot of mesh in
      // docker) + DBOS launch recovery + replay step + first chunks.
      await pollUntil(
        async () =>
          otherWatchers.some((w) => {
            for (const m of w.joined.matchAll(/t(\d+) chunk-/g)) {
              if (Number(m[1]) > killTime) return true;
            }
            return false;
          }),
        {
          timeoutMs: 120_000,
          intervalMs: 500,
          label: "replayed-pump-flowing",
        },
      );

      // Open a late /attach AFTER the replayed pump is flowing.
      // With the unconditional purge in prepareRun, this watcher sees
      // ONE copy of the response. Without it, a late /stream sees the
      // dead pod's prefix AND the replay → chunk-1 count == 2.
      lateWatcher = openAttachWatcher(
        otherWatchers[0]!.pod,
        session.orgSlug,
        threadId,
        session.apiKey,
      );

      await pollUntil(
        async () => otherWatchers.some((w) => w.joined.includes("chunk-20")),
        {
          timeoutMs: 90_000,
          intervalMs: 500,
          label: "final-chunk-after-replay",
        },
      );
      await pollUntil(async () => lateWatcher!.joined.includes("chunk-20"), {
        timeoutMs: 20_000,
        intervalMs: 200,
        label: "late-watcher-saw-final-chunk",
      });

      const chunk1Count = (lateWatcher.joined.match(/chunk-1 /g) ?? []).length;
      expect(chunk1Count).toBe(1);
    } finally {
      for (const w of watchers) w.abort.abort();
      lateWatcher?.abort.abort();
      await Promise.allSettled(watchers.map((w) => w.done));
      if (lateWatcher) await lateWatcher.done.catch(() => {});
    }
  }, 300_000);
});
