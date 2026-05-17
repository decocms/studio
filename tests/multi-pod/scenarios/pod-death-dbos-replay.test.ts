/**
 * Pod-death + DBOS workflow replay.
 *
 * ⚠️ Currently `.skip`ped — see "Architectural finding" below.
 *
 * Intended scenario: when the pod owning a run dies mid-stream, recovery
 * should resume the run on a survivor pod so /attach tails continue to
 * receive chunks without the client reconnecting.
 *
 * Test shape:
 *
 *   1. Send a SLOW message (20 chunks × 500ms ≈ 10s window for kill).
 *   2. Open /attach on all three pods so at least two survive the kill
 *      no matter which pod owns the run.
 *   3. Wait for "chunk-2" on any watcher (proof the run started).
 *   4. Read the actual owner from `threads.run_owner_pod` and SIGKILL
 *      that pod (POD_NAME on each compose service matches the service
 *      name, so the value maps directly to a `pod.kill()` target).
 *   5. Assert one surviving /attach receives "chunk-20".
 *
 * ── Architectural finding (2026-05-17, revised) ──────────────────────
 *
 * Running this test against the framework cluster surfaces three
 * separate, compounding gaps in the current cross-pod recovery story:
 *
 *   1. **No cross-pod DBOS recovery.** All pods boot DBOS with
 *      `executor_id = "local"` (default; env `DBOS__VMID` is unset).
 *      DBOS's `recoverPendingWorkflows` is filtered by executor_id, and
 *      it only fires on `DBOS.launch()` — i.e., when a pod restarts.
 *      The OSS SDK has no built-in scan for workflows whose executor is
 *      dead. Surviving peers never replay a dead pod's workflows.
 *
 *   2. **`prepareRun` purges JetStream unconditionally** at
 *      dispatch-run.ts:519, including on resume. Even if the heartbeat
 *      watcher (NatsPodHeartbeat + runRegistry.handlePodDeath) does
 *      kick in and trigger `dispatchRunAndWait(isResume: true)` on a
 *      survivor pod, the first thing that runs nukes any chunks the
 *      survivor watchers were mid-consumption of.
 *
 *   3. **NatsPodHeartbeat bucket creation is fragile**. On cold boot
 *      `KV_POD_HEARTBEATS` sometimes isn't in NATS' jsz output even
 *      though every other JS resource is — bucket init silently
 *      swallows errors at app.ts:867. Re-runs eventually create it,
 *      but it's flaky enough that you can't rely on the heartbeat
 *      firing in the first 45s window.
 *
 * Net: permanent pod death is currently only recovered when the dead
 * pod *itself* restarts (DBOS recovery on the same POD_NAME succeeds
 * because `claimRunStart`'s strict CAS matches). Cross-pod recovery
 * needs:
 *
 *   - per-pod `DBOS__VMID` so DBOS knows which executor owns what
 *   - a death-detection mechanism (the existing NATS heartbeat, or
 *     Postgres advisory locks — sub-second detection, no NATS bucket
 *     reliability issue) that triggers recovery on a survivor
 *   - skip `streamBuffer.purge()` when `isResume` is true
 *
 * The recovery itself can stay in `runRegistry.handlePodDeath`
 * (storage-level claim + `dispatchRunAndWait(isResume: true)`) — going
 * through DBOS's internal recoverPendingWorkflows API is possible but
 * not exposed publicly, so it'd require importing internals.
 *
 * Un-skip this test once the three gaps above are addressed. The test
 * body is left intact so the fix can be verified by removing the
 * `.skip` and re-running.
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
    try {
      await pollUntil(
        async () => survivors.some((w) => w.joined.includes("chunk-20")),
        {
          // Window has to cover: heartbeat KV TTL (45s) + NATS purge
          // sweep + handlePodDeath claim + dispatchRunAndWait resume +
          // ~2.5s of mock chunks ≈ 55s worst case. 90s leaves comfortable
          // margin for cold-boot variance without dragging green runs.
          timeoutMs: 90_000,
          intervalMs: 500,
          label: "final-chunk-after-replay",
        },
      );
    } finally {
      // Always close out the SSE consumers so the test process exits
      // cleanly even on assertion failure.
      for (const w of watchers) w.abort.abort();
      await Promise.allSettled(watchers.map((w) => w.done));
    }
    // Test budget exceeds pollUntil by a safety margin so the finally
    // above always runs (cleanly aborts SSE consumers) instead of
    // racing the bun-test-level timeout.
  }, 150_000);
});
