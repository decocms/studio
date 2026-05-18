/**
 * Pod-death recovery scenario.
 *
 * When the pod owning a run dies mid-stream, a survivor pod must take
 * over the run via the heartbeat watcher and the resumed run's chunks
 * must reach /attach tails on the survivor side — that's the whole
 * point of the recovery path.
 *
 * ── What the test exercises ──────────────────────────────────────────
 *
 *   1. POST a SLOW message (20 chunks × 500ms ≈ 10s) so we have a
 *      window to kill the owner mid-stream.
 *   2. Open /attach on all three pods. Whichever pod ends up owning
 *      the run, the other two stay alive and observe the recovery.
 *   3. Wait for chunk-2 on any watcher — proof the run is flowing.
 *   4. Read `threads.run_owner_pod` (POD_NAME maps 1:1 to the compose
 *      service name) and SIGKILL that pod.
 *   5. The heartbeat poller on a survivor pod (kv.keys() diff every
 *      10s) detects the vanished heartbeat key and fires
 *      `runRegistry.handlePodDeath`, which claims the orphan and
 *      re-dispatches with `isResume: true`.
 *   6. Wait until a survivor sees chunk-3 (which can only come from the
 *      resumed run, since the dead pod only got past chunk-2). Then
 *      open a fresh /attach against a survivor.
 *   7. Assert: the late /attach sees chunks 1..20 EXACTLY ONCE — i.e.,
 *      `chunk-1 ` appears once in its joined stream. If the resumed
 *      run had pumped on top of the dead pod's leftover prefix in
 *      JetStream (i.e., if prepareRun's purge ever regressed), a late
 *      /attach would see the assistant's reply duplicated end-to-end
 *      and the count would be 2.
 *
 * ── What had to be fixed for this to pass ────────────────────────────
 *
 *   - **Heartbeat polling fallback**: NATS KV TTL expiry doesn't fire
 *     watcher events. Without a poll, SIGKILL'd pods are never
 *     detected. (`apps/mesh/src/nats/pod-heartbeat.ts`)
 *
 *   - **streamBuffer in recovery dispatch**: `resumeOrphanedThread`
 *     was deliberately dropping streamBuffer when calling
 *     dispatchRunAndWait, so the resumed run streamed to /dev/null.
 *     (`apps/mesh/src/api/app.ts`)
 *
 *   - **Keep the unconditional purge**: an early version of this PR
 *     skipped `streamBuffer.purge()` on resume, but that left the
 *     dead pod's prefix in JetStream and any /attach opened after
 *     recovery would see the response duplicated. The chunk-1 count
 *     assertion below is the regression guard for this.
 *     (`apps/mesh/src/api/routes/decopilot/dispatch-run.ts`)
 */

import { describe, expect, test } from "bun:test";
import { postJson, sse } from "../lib/client";
import { getThreadRunOwnerPod } from "../lib/db";
import { registerTestHooks } from "../lib/hooks";
import { kill } from "../lib/pod";
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
        `/api/${orgSlug}/decopilot/attach/${threadId}`,
        { auth: { apiKey }, signal: abort.signal },
      )) {
        watcher.joined += payload;
      }
    } catch (err) {
      // Aborts and connection drops (when the owning pod dies) are
      // expected in this scenario — swallow them. Anything else
      // re-throws so the test sees it. Bun's fetch surfaces the
      // condition as either an `AbortError`, a system error with a
      // `code` property (ECONNRESET/ECONNREFUSED), or a generic "socket
      // connection was closed" message; cover all three.
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
  test("killing the owning pod mid-stream still delivers the final chunk via a survivor", async () => {
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

    // Open watchers on all three pods. Whichever pod we end up killing,
    // the other two stay alive and at least one of them sees the run
    // through to completion.
    const watchers = ALL_PODS.map((pod) =>
      openAttachWatcher(pod, session.orgSlug, threadId, session.apiKey),
    );

    // Wait until at least one watcher sees a chunk — proves the run
    // is actually flowing before we go knock a pod over.
    await pollUntil(
      async () => watchers.some((w) => w.joined.includes("chunk-2")),
      {
        timeoutMs: 15_000,
        intervalMs: 200,
        label: "run-flowing-before-kill",
      },
    );

    // Identify the dispatch owner from the DB (POD_NAME equals the
    // compose service name, so the value here is a valid PodName).
    const ownerRaw = await pollUntil(
      async () => (await getThreadRunOwnerPod(threadId)) !== null,
      {
        timeoutMs: 5_000,
        intervalMs: 200,
        label: "owner-pod-claimed",
      },
    )
      .then(() => getThreadRunOwnerPod(threadId))
      .then((v) => v as PodName);
    expect(["mesh-1", "mesh-2", "mesh-3"]).toContain(ownerRaw);

    console.log(`  → run owned by ${ownerRaw}; SIGKILLing it`);
    await kill(ownerRaw);

    // Survivor watchers (everything except the killed pod) must
    // eventually see the final chunk. We don't care which one — any
    // single survivor receiving "chunk-20" proves the pump resumed
    // on a replay-target pod and JetStream caught it back up.
    const survivors = watchers.filter((w) => w.pod.service !== ownerRaw);
    let lateWatcher: Watcher | null = null;
    try {
      // First: wait until a survivor sees a chunk that *must* be from
      // the resumed run (the dead pod only ever got past chunk-2 before
      // we SIGKILL'd it). chunk-3 is the earliest signal that the
      // resumed pump has run, and — critically — that prepareRun has
      // already purged the per-thread subject. This means a /attach
      // opened from this moment forward sees only the resumed run's
      // chunks, not the dead pod's prefix.
      await pollUntil(
        async () => survivors.some((w) => w.joined.includes("chunk-3")),
        {
          timeoutMs: 75_000,
          intervalMs: 500,
          label: "resumed-pump-flowing",
        },
      );

      // Open a late /attach AFTER the resumed pump is flowing. With
      // the unconditional purge in prepareRun, this watcher sees ONE
      // copy of the response (chunks from the resumed run only). If
      // purge ever regresses (e.g. someone gates it on isResume), the
      // late watcher would see chunks from BOTH the dead pod's pre-kill
      // prefix AND the resumed pod's full body — the assistant reply
      // duplicated end-to-end.
      lateWatcher = openAttachWatcher(
        survivors[0]!.pod,
        session.orgSlug,
        threadId,
        session.apiKey,
      );

      // Now wait for chunk-20 on the original survivor (proves the
      // resumed run completed end-to-end), THEN on the late watcher
      // (proves it received the tail too).
      await pollUntil(
        async () => survivors.some((w) => w.joined.includes("chunk-20")),
        {
          // Window has to cover: heartbeat KV TTL (45s) + poller tick +
          // handlePodDeath claim + dispatchRunAndWait resume + ~10s of
          // mock chunks ≈ 70s worst case. 90s leaves comfortable margin
          // for cold-boot variance without dragging green runs.
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

      // The load-bearing duplicate-detection assertion. `chunk-1 `
      // (with trailing space) is what the mock emits as its first
      // text-delta; counting its occurrences in the SSE payload tells
      // us how many copies of the response landed on the wire.
      // Exactly one ⇒ purge worked. Two ⇒ the resumed run's chunks
      // were appended to the dead pod's prefix, and any user-facing
      // late /attach would render the reply twice.
      const chunk1Count = (lateWatcher.joined.match(/chunk-1 /g) ?? []).length;
      expect(chunk1Count).toBe(1);
    } finally {
      // Always close out the SSE consumers so the test process exits
      // cleanly even on assertion failure.
      for (const w of watchers) w.abort.abort();
      lateWatcher?.abort.abort();
      await Promise.allSettled(watchers.map((w) => w.done));
      if (lateWatcher) await lateWatcher.done.catch(() => {});
    }
    // Test budget exceeds pollUntil by a safety margin so the finally
    // above always runs (cleanly aborts SSE consumers) instead of
    // racing the bun-test-level timeout.
  }, 220_000);
});
