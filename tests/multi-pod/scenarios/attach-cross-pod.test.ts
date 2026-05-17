/**
 * Cross-pod /attach — the headline scenario for this test framework.
 *
 * This directly validates the deliverPolicy fix that was merged in
 * PR #3387: `/attach` picks `"all"` vs `"new"` based on `thread.status`
 * from the DB, not the pod-local registry. Without the fix, a client
 * attaching to a pod that doesn't own the run would silently miss
 * already-buffered chunks.
 *
 * Setup keeps the bug catchable regardless of which pod DBOS happens
 * to dispatch the workflow on:
 *
 *   1. Mock is configured to drip slowly (300ms × 5 chunks ≈ 1.5s).
 *   2. POST goes to pod-1. DBOS picks an arbitrary pod to run the
 *      threadGateWorkflow step; we don't try to pin it.
 *   3. We wait ~500ms so a couple of chunks are already in JetStream.
 *   4. Two attaches open on pod-2 AND pod-3 (deliberately *not* pod-1
 *      to maximize the chance of hitting the cross-pod code path).
 *   5. Both attaches must receive at least the first chunk — the one
 *      most likely to be dropped by the `"new"` deliverPolicy bug.
 *
 * If pod-2 or pod-3 happens to be the dispatch owner, isRunning() is
 * true locally and "all" is picked the easy way — that case passes
 * pre-fix too. If pod-1 (or any non-attached pod) is the owner, the
 * test exercises the actual cross-pod path. Over a few CI runs we get
 * coverage of all three.
 */

import { describe, expect, test } from "bun:test";
import { postJson, sse } from "../lib/client";
import { registerTestHooks } from "../lib/hooks";
import { PODS } from "../lib/pods";
import {
  bootstrapSession,
  createTestAgent,
  createTestThread,
  wireMockProvider,
} from "../lib/setup";

registerTestHooks();

// Encoded in the prompt — mesh strips request headers before calling
// the provider, so hints live in the message text instead. mock-ai
// parses "slow:NxMS" to mean N chunks at M ms intervals.
const MOCK_HINT = "slow:5x500"; // ~2.5s total run

/** Collect SSE payloads from /attach until `predicate` is satisfied or
 *  the timeout fires. Aborts the underlying request on either outcome. */
async function collectAttachUntil(
  pod: (typeof PODS)["MESH_2"],
  orgSlug: string,
  threadId: string,
  apiKey: string,
  predicate: (joined: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let joined = "";

  try {
    for await (const payload of sse(
      pod,
      `/api/${orgSlug}/decopilot/attach/${threadId}`,
      { auth: { apiKey }, signal: controller.signal },
    )) {
      joined += payload;
      if (predicate(joined)) return joined;
    }
  } catch (err) {
    // AbortError on timeout is expected; rethrow anything else.
    if (
      err instanceof Error &&
      err.name !== "AbortError" &&
      !err.message.includes("aborted")
    ) {
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }

  return joined;
}

describe("cross-pod /attach", () => {
  test("attach on non-POST pods receives buffered chunks from the live run", async () => {
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

    // Let the run start streaming and buffer 1-2 chunks. If we
    // attached immediately, the "new" deliverPolicy bug would still
    // get the rest of the chunks and the test would pass for the
    // wrong reason.
    await Bun.sleep(500);

    // Attach on two pods that are *not* the POST pod. Both must see
    // the very first chunk ("chunk-1") to prove the cross-pod tail
    // is actually replaying the buffered prefix.
    const [pod2Joined, pod3Joined] = await Promise.all([
      collectAttachUntil(
        PODS.MESH_2,
        session.orgSlug,
        threadId,
        session.apiKey,
        (s) => s.includes("chunk-1"),
        15_000,
      ),
      collectAttachUntil(
        PODS.MESH_3,
        session.orgSlug,
        threadId,
        session.apiKey,
        (s) => s.includes("chunk-1"),
        15_000,
      ),
    ]);

    expect(pod2Joined).toContain("chunk-1");
    expect(pod3Joined).toContain("chunk-1");
  }, 30_000);
});
