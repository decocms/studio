/**
 * Rollout churn — a thread must survive redeploys of the cluster mid-run.
 *
 * Reproduces, locally, the staging failure behind the recurring "No response
 * was generated": pods there force-exit roughly every ~15 min (the 115s
 * graceful-drain timeout → SIGKILL), interrupting whatever run they own. A
 * user iterating quickly keeps landing on an interrupted run whose answer is
 * lost — either a blank bubble or a cryptic terminal error.
 *
 * Shared setup drives one long run, then rolls the WHOLE cluster like a
 * rolling deploy: SIGKILL each pod in turn (matching staging's forced exit)
 * and bring it back healthy. `run_owner_pod` isn't populated in this
 * architecture, so recycling every pod guarantees the (unknown) owner is
 * hard-killed mid-flight.
 *
 * Two invariants, at two strengths:
 *
 *   1. LIVE GATE (must stay green): a rollout never leaves the thread blank
 *      or stuck — it reaches a terminal state (not wedged in_progress) AND its
 *      assistant message has ≥1 renderable part (not the empty "No response
 *      was generated"). This guards the two worst user-facing outcomes.
 *
 *   2. FULL RECOVERY (skipped — currently reproduces the bug): the run should
 *      actually SURVIVE and complete. Today it does not: DBOS recovery resumes
 *      the workflow, but the JetStream subject is gapped/purged across the
 *      kill+resume, so the projector fails with
 *      `stream truncated ... missing seq 1` and marks the run `failed` with a
 *      cryptic `Error: missing seq 1` part. Un-skip once resume stops purging
 *      the subject and recovery replays the full chunk log (see the recovery
 *      gaps documented in pod-death-dbos-replay.test.ts).
 */

import { describe, expect, test } from "bun:test";
import { postJson } from "../lib/client";
import { countRenderableAssistantParts, getThreadStatus } from "../lib/db";
import { waitReady } from "../lib/cluster";
import { registerTestHooks } from "../lib/hooks";
import { kill, start } from "../lib/pod";
import { ALL_PODS, PODS } from "../lib/pods";
import { pollUntil } from "../lib/poll-until";
import {
  bootstrapSession,
  createTestAgent,
  createTestThread,
  wireMockProvider,
} from "../lib/setup";

registerTestHooks();

/** ~3 min of in-flight streaming — stays running across a full rolling deploy. */
const MOCK_HINT = "slow:180x1000";
const TERMINAL = new Set(["completed", "failed", "requires_action"]);

/**
 * Start a long run, wait until it's dispatched, then SIGKILL+restart every pod
 * (one rolling deploy) and wait for the thread to reach a terminal state.
 * Returns the terminal status and the renderable-assistant-part count.
 */
async function runThroughRollingDeploy(): Promise<{
  status: string | null;
  renderable: number;
}> {
  const session = await bootstrapSession(PODS.STUDIO_1);
  await wireMockProvider(PODS.STUDIO_1, session);
  const { virtualMcpId } = await createTestAgent(PODS.STUDIO_1, session);
  const { threadId } = await createTestThread(
    PODS.STUDIO_1,
    session,
    virtualMcpId,
  );

  const postRes = await postJson(
    PODS.STUDIO_1,
    `/api/${session.orgSlug}/decopilot/threads/${threadId}/messages`,
    {
      messages: [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: MOCK_HINT }],
        },
      ],
      agent: { id: virtualMcpId },
      tier: "smart",
    },
    { auth: { apiKey: session.apiKey } },
  );
  expect(postRes.status).toBe(202);

  // Proof the run was dispatched before we churn (run_owner_pod stays null in
  // this architecture, so gate on the thread status).
  await pollUntil(
    async () => (await getThreadStatus(threadId)) === "in_progress",
    { timeoutMs: 30_000, intervalMs: 500, label: "run-dispatched" },
  );

  // Rolling deploy: SIGKILL each pod in turn and bring it back, healthy
  // between pods. The run's (unknown) owner is hard-killed mid-flight.
  for (const pod of ALL_PODS) {
    console.log(`  → recycling ${pod.service} (SIGKILL + restart)`);
    await kill(pod.service);
    await start(pod.service);
    await waitReady();
  }

  // A hang here (timeout) is itself a caught bug: the run wedged in_progress.
  await pollUntil(
    async () => {
      const status = await getThreadStatus(threadId);
      return status !== null && TERMINAL.has(status);
    },
    { timeoutMs: 240_000, intervalMs: 1000, label: "run-terminal" },
  );

  const status = await getThreadStatus(threadId);
  const renderable = await countRenderableAssistantParts(threadId);
  console.log(
    `  → terminal status=${status}, renderable assistant parts=${renderable}`,
  );
  return { status, renderable };
}

describe("rollout churn", () => {
  test("a rolling deploy never leaves the thread blank or stuck", async () => {
    const { renderable } = await runThroughRollingDeploy();
    // The invariant behind "No response was generated": a terminal turn must
    // never be empty. (`runThroughRollingDeploy` already fails the test if
    // the run wedges in_progress — the terminal poll times out.)
    expect(renderable).toBeGreaterThan(0);
  }, 600_000);

  // Un-skip once rollout recovery is complete (see file header). Currently the
  // run is marked `failed` with `missing seq 1` instead of completing.
  test.skip("a run survives a rolling deploy and completes", async () => {
    const { status } = await runThroughRollingDeploy();
    expect(status).toBe("completed");
  }, 600_000);
});
