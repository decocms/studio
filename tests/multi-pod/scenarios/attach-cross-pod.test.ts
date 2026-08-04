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
 *   1. Mock is configured to drip slowly (500ms × 5 chunks ≈ 2.5s) — see
 *      MOCK_HINT below; this gives the test time to attach after chunk-1
 *      has already buffered in JetStream.
 *   2. POST goes to pod-1. DBOS picks an arbitrary pod to run the
 *      threadGateWorkflow step; we don't try to pin it.
 *   3. We open a throwaway /attach on pod-1 as a synchronization probe
 *      and wait until *it* sees chunk-1 — deterministic signal that
 *      the chunk is now in JetStream. A fixed sleep was racy because
 *      a fast dispatch chain could publish chunk-1 *after* the test's
 *      attaches opened, in which case `deliverPolicy: "new"` would
 *      still deliver chunk-1 live and the bug wouldn't manifest.
 *   4. Two attaches open on pod-2 AND pod-3 (deliberately *not* pod-1
 *      to maximize the chance of hitting the cross-pod code path).
 *   5. Both attaches must receive chunk-1 — the one most likely to be
 *      dropped by the `"new"` deliverPolicy bug, now guaranteed to be
 *      *already in JetStream* by the time we subscribe.
 *
 * If pod-2 or pod-3 happens to be the dispatch owner, isRunning() is
 * true locally and "all" is picked the easy way — that case passes
 * pre-fix too. If pod-1 (or any non-attached pod) is the owner, the
 * test exercises the actual cross-pod path. Over a few CI runs we get
 * coverage of all three.
 *
 * ── unified-control-plane T9 extension ────────────────────────────────
 * This cluster's `docker-compose.yml` pins every Studio pod to
 * `STUDIO_AGENT_SANDBOX_ENABLED=true` (see that file's comment on the
 * the first service), so `resolveDispatchTarget` short-circuits every
 * dispatch in this suite to HOSTED execution — this test already drives a
 * hosted streaming turn through the (now v4) gate: dispatch →
 * `hostedHarnessWorkflow` (detached, not awaited) → `consumeRunProjection`
 * live-tailing the subject, identically to desktop. That makes this the
 * multi-pod suite's existing streaming-turn scenario the T9 proof
 * obligations ask to extend, rather than write a parallel one: chunks
 * observed on `/stream` while `in_progress` (below, right after chunk-1 is
 * confirmed on both survivor pods — the run cannot have reached a terminal
 * status yet, since mock-ai hasn't sent chunks 2-5 or its `stop` frame),
 * terminal `completed`, and parts persisted exactly once (a part count
 * that's stable across two reads taken a beat apart — the exact count mock-ai's
 * chunk-to-part folding produces isn't a stable contract to pin here).
 */

import { describe, expect, test } from "bun:test";
import { postJson, sse } from "../lib/client";
import { countThreadMessageParts, getThreadStatus } from "../lib/db";
import { registerTestHooks } from "../lib/hooks";
import { PODS } from "../lib/pods";
import { pollUntil } from "../lib/poll-until";
import {
  bootstrapSession,
  createTestAgent,
  createTestThread,
  wireMockProvider,
} from "../lib/setup";

registerTestHooks();

// Encoded in the prompt — Studio strips request headers before calling
// the provider, so hints live in the message text instead. mock-ai
// parses "slow:NxMS" to mean N chunks at M ms intervals.
const MOCK_HINT = "slow:5x500"; // ~2.5s total run

/** Collect SSE payloads from /attach until `predicate` is satisfied or
 *  the timeout fires. Aborts the underlying request on either outcome. */
async function collectAttachUntil(
  pod: (typeof PODS)["STUDIO_2"],
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
      `/api/${orgSlug}/decopilot/threads/${threadId}/stream`,
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
    const session = await bootstrapSession(PODS.STUDIO_1);
    await wireMockProvider(PODS.STUDIO_1, session);
    const { virtualMcpId } = await createTestAgent(PODS.STUDIO_1, session);
    const { threadId } = await createTestThread(
      PODS.STUDIO_1,
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
      PODS.STUDIO_1,
      `/api/${session.orgSlug}/decopilot/threads/${threadId}/messages`,
      messageBody,
      { auth: { apiKey: session.apiKey } },
    );
    expect(postRes.status).toBe(202);

    // Synchronization probe: open a throwaway /attach on pod-1 and
    // wait until *it* sees chunk-1. That's a deterministic signal
    // that chunk-1 is now in JetStream (any subscription opened from
    // here on would have to use `deliverPolicy: "all"` to see it).
    // A fixed sleep would be racy — if the dispatch chain (DBOS
    // dequeue → prepareRun → streamText init) finished before the
    // mock's first chunk-delay tick, the test attaches would still
    // see chunk-1 live via `"new"` and the bug wouldn't manifest.
    await collectAttachUntil(
      PODS.STUDIO_1,
      session.orgSlug,
      threadId,
      session.apiKey,
      (s) => s.includes("chunk-1"),
      15_000,
    );

    // Now attach on the two pods that are *not* the POST pod. By the
    // time these subscriptions open, chunk-1 is already in JetStream,
    // so seeing it on the other side requires the deliverPolicy fix
    // to pick "all" (or the survivor pod happens to also be the
    // dispatch owner, in which case the local-registry fast path
    // would catch it pre-fix too — still useful coverage for the
    // happy path).
    const [pod2Joined, pod3Joined] = await Promise.all([
      collectAttachUntil(
        PODS.STUDIO_2,
        session.orgSlug,
        threadId,
        session.apiKey,
        (s) => s.includes("chunk-1"),
        15_000,
      ),
      collectAttachUntil(
        PODS.STUDIO_3,
        session.orgSlug,
        threadId,
        session.apiKey,
        (s) => s.includes("chunk-1"),
        15_000,
      ),
    ]);

    expect(pod2Joined).toContain("chunk-1");
    expect(pod3Joined).toContain("chunk-1");

    // ── unified-control-plane T9: chunks observed on /stream while the run
    // is still `in_progress`. Both survivor pods have only just confirmed
    // chunk-1 — mock-ai's remaining 4 chunks + `stop` frame (500ms apart)
    // haven't been sent yet, so the projector cannot have written a
    // terminal status yet.
    expect(await getThreadStatus(threadId)).toBe("in_progress");

    // ── Terminal: the hosted run reaches `completed` once mock-ai finishes
    // streaming (~2.5s total for MOCK_HINT's 5 chunks).
    await pollUntil(
      async () => (await getThreadStatus(threadId)) === "completed",
      {
        timeoutMs: 15_000,
        intervalMs: 250,
        label: "hosted-turn-completed",
      },
    );

    // ── Parts persisted EXACTLY ONCE: the count is stable across two reads
    // taken a beat apart. A double-projection bug (e.g. the v4 gate's
    // live-tail somehow re-consuming the same run) would show up as the
    // count still climbing after the terminal write, not as a fixed wrong
    // number.
    const countAfterTerminal = await countThreadMessageParts(threadId);
    expect(countAfterTerminal).toBeGreaterThan(0);
    await Bun.sleep(1_000);
    expect(await countThreadMessageParts(threadId)).toBe(countAfterTerminal);
    // Extended from 30s (the pre-T9 upper bound for the chunk-1 cross-pod
    // race alone) to cover the added completed-terminal poll + stability
    // sleep above.
  }, 60_000);
});
