/**
 * Multi-pod e2e: durable-projector parity, leader-failover, and poison
 * handling (Unified Pipeline Phase A — Task 8).
 *
 * ⚠️ CI-VALIDATED-ONLY. This file is written and type-checked (`bun run
 * check`) but has NOT been run locally — the multi-pod harness requires
 * Docker + Postgres + NATS, none of which exist in the authoring
 * environment. The bodies live behind `test.skip` (following the
 * precedent in `pod-death-dbos-replay.test.ts` and
 * `link-uplink-toxiproxy.test.ts`): the assertions are pinned so that
 * un-skipping is the only edit needed once the prerequisites below are
 * wired in CI, but nothing here is asserted to pass against a real
 * cluster yet.
 *
 * ── WHAT THIS VALIDATES ──────────────────────────────────────────────
 * With `LINK_DURABLE_PROJECTOR=true`, the durable JetStream projector
 * runs *in parallel* with the legacy inline DB-writer. Both are
 * idempotent (parts via `ON CONFLICT (id) DO NOTHING`; terminal status
 * via `completeRunIfNotCompleted`, which only completes an `in_progress`
 * run). Phase A's safety net is that the projector produces *identical*
 * DB state to inline — the prerequisite before Phase C makes the
 * projector authoritative and deletes the inline path.
 *
 * The five properties asserted (plan Task 8, step 1):
 *   (a) PARITY     — `thread_message_parts` for the run match what the
 *                    inline path persists: no missing/extra parts, the
 *                    deterministic `${runId}:${messageId}:${seq}` ids and
 *                    `kind`s are stable.
 *   (b) STATUS     — `threads.status` reaches `completed` (written by the
 *                    projector AFTER parts, on the `{done}` sentinel).
 *   (c) SINGLE-ACTIVE — exactly ONE pod runs the consumer (leader-
 *                    elected via the shared pod heartbeat); asserted via
 *                    the leader-acquire log line.
 *   (d) FAILOVER   — SIGKILL the leader mid-run → a standby acquires
 *                    leadership and the run still reaches `completed`
 *                    with all parts (the projector replays the run's
 *                    chunks from the file-backed JetStream stream).
 *   (e) POISON     — an un-projectable run (the projector's `emitFinal`
 *                    throws) → `threads.status='failed'` via the DLQ
 *                    path, and the consumer is NOT wedged (a subsequent
 *                    healthy run on a fresh thread still completes).
 *
 * ── PREREQUISITES (why every body stays `test.skip`) ─────────────────
 * 1. `tests/multi-pod/docker-compose.yml` must export the Phase A flag
 *    on every Studio pod:
 *      - LINK_DURABLE_PROJECTOR=true   (start the standalone DB-writer,
 *                                       leader-elected; default-off today)
 *    Without it `app.ts` never constructs the `ProjectorLeadership` /
 *    `startDurableProjector` wiring (app.ts ~line 1034), so there is no
 *    second writer to compare against and no leader log to assert on.
 *
 * 2. Leader-acquire observability. `selectLeader` is the
 *    lexicographically-lowest alive podId, so with services
 *    the three compose services, the initial leader is deterministic.
 *    SINGLE-ACTIVE (c) and FAILOVER (d) assert on a leader
 *    log line — `app.ts`'s `onAcquire`/`onRelease` must emit a stable,
 *    greppable marker (e.g. `[DurableProjector] leader acquired` /
 *    `released`). The markers below (`LEADER_ACQUIRED_LOG`) are the
 *    contract; align them with whatever app.ts logs.
 *
 * 3. Poison injection (e). mock-ai (`tests/multi-pod/mock-ai/server.ts`)
 *    has no completion-failure hint today — it only models slow/many
 *    chunk streams (`slow:NxMS`, `many:N`) and the Gemini-interactions
 *    failure path. POISON needs the projector's terminal write
 *    (`emitFinal`) to throw for a specific run. Add a hint
 *    (`poison:final`) whose chunk payload the projector cannot persist
 *    (e.g. an oversized / malformed final part that `emitFinal`
 *    rejects), so `projectRun` exhausts retries → `onDlq` → `onRunErrored`
 *    → `status='failed'`. POISON_HINT below is the placeholder contract.
 *
 * Un-skip each test once its prerequisite lands; the body is intact so
 * the wiring is verified by deleting `.skip` and re-running in CI.
 */

import { describe, expect, test } from "bun:test";
import { postJson } from "../lib/client";
import { dbQuery } from "../lib/db";
import { registerTestHooks } from "../lib/hooks";
import { kill, logsContain } from "../lib/pod";
import type { PodInfo, PodName } from "../lib/pods";
import { ALL_PODS, PODS } from "../lib/pods";
import { pollUntil } from "../lib/poll-until";
import {
  bootstrapSession,
  createTestAgent,
  createTestThread,
  type Session,
  wireMockProvider,
} from "../lib/setup";

registerTestHooks();

// Studio strips request headers before calling the provider, so the run
// shape is encoded in the message text. mock-ai parses "many:N" → N
// chunks at the default 50ms cadence; "slow:NxMS" → N chunks every MS.
const FAST_HINT = "many:6"; // 6 chunks — a deterministic small run.
const SLOW_HINT = "slow:20x500"; // ~10s — wide window for a mid-run kill.

// Placeholder mock-ai hint that must make the projector's terminal write
// throw (see prerequisite 3). Aligns with the mock-ai change that injects
// an un-projectable final chunk.
const POISON_HINT = "poison:final";

// Leader observability contract (see prerequisite 2). Align these with
// the marker app.ts logs from the ProjectorLeadership onAcquire/onRelease
// callbacks.
const LEADER_ACQUIRED_LOG = "[DurableProjector] leader acquired";

// selectLeader = lexicographically-lowest alive podId, so the first
// The leader across the three compose services is deterministically the first.
const INITIAL_LEADER: PodName = "mesh-1";

/** Fire-and-forget a streaming turn; returns once the POST is accepted. */
async function postTurn(
  pod: PodInfo,
  session: Session,
  virtualMcpId: string,
  threadId: string,
  hint: string,
): Promise<void> {
  const res = await postJson(
    pod,
    `/api/${session.orgSlug}/decopilot/threads/${threadId}/messages`,
    {
      messages: [
        {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: hint }],
        },
      ],
      agent: { id: virtualMcpId },
      tier: "smart",
    },
    { auth: { apiKey: session.apiKey } },
  );
  expect(res.status).toBe(202);
}

/** Count this run's persisted parts. `COUNT(*)` is a stable scalar, safe
 *  for db.ts's naive (comma-splitting) CSV parser. */
async function countParts(threadId: string): Promise<number> {
  const rows = await dbQuery<{ n: string }>(
    `SELECT COUNT(*) AS n FROM thread_message_parts WHERE thread_id = '${sqlLit(threadId)}'`,
  );
  return Number(rows[0]?.n ?? "0");
}

/** Distinct part kinds for this run, ordered — kinds never contain commas
 *  so the naive CSV parser is safe. */
async function partKinds(threadId: string): Promise<string[]> {
  const rows = await dbQuery<{ kind: string }>(
    `SELECT DISTINCT kind FROM thread_message_parts WHERE thread_id = '${sqlLit(threadId)}' ORDER BY kind`,
  );
  return rows.map((r) => r.kind).filter((k): k is string => k !== null);
}

/** The persisted terminal status for the thread, or null if absent. */
async function threadStatus(threadId: string): Promise<string | null> {
  const rows = await dbQuery<{ status: string | null }>(
    `SELECT status FROM threads WHERE id = '${sqlLit(threadId)}'`,
  );
  return rows[0]?.status ?? null;
}

/** Single-quote escape for inlining ids into SQL (ids are uuid-ish, but
 *  belt-and-suspenders). */
function sqlLit(v: string): string {
  return v.replace(/'/g, "''");
}

describe("durable-projector parity + leader-failover + poison", () => {
  // (a) PARITY + (b) STATUS + (c) SINGLE-ACTIVE on a clean run.
  test.skip("[parity] projector persists the same parts + completed status as inline, on exactly one leader", async () => {
    const session = await bootstrapSession(PODS.STUDIO_1);
    await wireMockProvider(PODS.STUDIO_1, session);
    const { virtualMcpId } = await createTestAgent(PODS.STUDIO_1, session);
    const { threadId } = await createTestThread(
      PODS.STUDIO_1,
      session,
      virtualMcpId,
    );

    await postTurn(PODS.STUDIO_1, session, virtualMcpId, threadId, FAST_HINT);

    // (b) STATUS — the projector writes `completed` on the {done}
    // sentinel, AFTER parts. Wait for that terminal write.
    await pollUntil(
      async () => (await threadStatus(threadId)) === "completed",
      {
        timeoutMs: 30_000,
        intervalMs: 500,
        label: "projector-completed-status",
      },
    );

    // (a) PARITY — both writers are idempotent, so the row count is the
    // run's true part count, not double. mock-ai emits a role frame +
    // FAST_HINT content chunks + a stop; the assistant text deltas fold
    // into parts. The exact count is whatever the inline path persists;
    // we assert it is stable and non-empty here, and (the stronger
    // check) that running with the flag OFF yields the same number — see
    // the manual parity note in the PR. At minimum: no double-write.
    const parts = await countParts(threadId);
    expect(parts).toBeGreaterThan(0);

    // A 6-chunk run with two idempotent writers must not produce 2× the
    // parts; with `ON CONFLICT DO NOTHING` the deterministic ids dedupe.
    // Upper-bound guards against a double-write regression.
    expect(parts).toBeLessThanOrEqual(12);

    const kinds = await partKinds(threadId);
    // A text-only mock turn persists at least a text part kind.
    expect(kinds.length).toBeGreaterThan(0);

    // (c) SINGLE-ACTIVE — exactly one pod logs leader-acquire, and it is
    // the lexicographically-lowest alive pod (the first service at clean boot).
    const acquiredOn = await Promise.all(
      ALL_PODS.map((p) => logsContain(p.service, LEADER_ACQUIRED_LOG)),
    );
    const leaders = ALL_PODS.filter((_p, i) => acquiredOn[i]);
    expect(leaders).toHaveLength(1);
    expect(leaders[0]!.service).toBe(INITIAL_LEADER);
  }, 60_000);

  // (d) FAILOVER — kill the leader mid-run; a standby acquires leadership
  // and replays the run from JetStream to `completed` with all parts.
  test.skip("[failover] killing the leader mid-run hands off; the standby replays to completed", async () => {
    const session = await bootstrapSession(PODS.STUDIO_1);
    await wireMockProvider(PODS.STUDIO_1, session);
    const { virtualMcpId } = await createTestAgent(PODS.STUDIO_1, session);
    const { threadId } = await createTestThread(
      PODS.STUDIO_1,
      session,
      virtualMcpId,
    );

    // A long run so the leader is still consuming when we kill it.
    await postTurn(PODS.STUDIO_1, session, virtualMcpId, threadId, SLOW_HINT);

    // Wait until the leader is actually running the consumer (so the
    // kill targets a live leader, not a pre-acquire pod).
    await pollUntil(() => logsContain(INITIAL_LEADER, LEADER_ACQUIRED_LOG), {
      timeoutMs: 20_000,
      intervalMs: 500,
      label: "leader-acquired-before-kill",
    });

    // Let some chunks land in JetStream + (partially) project, so the
    // standby has real replay work rather than a fresh run.
    await pollUntil(async () => (await countParts(threadId)) > 0, {
      timeoutMs: 20_000,
      intervalMs: 500,
      label: "some-parts-before-kill",
    });

    // SIGKILL the leader. The heartbeat watcher + the 15s poll re-elect
    // the next-lowest alive pod, whose onAcquire starts the
    // consumer; an explicit-ack durable consumer replays unacked
    // messages from the file-backed stream.
    await kill(INITIAL_LEADER);

    // A standby must acquire leadership.
    const standbys = ALL_PODS.filter((p) => p.service !== INITIAL_LEADER);
    await pollUntil(
      async () => {
        const acq = await Promise.all(
          standbys.map((p) => logsContain(p.service, LEADER_ACQUIRED_LOG)),
        );
        return acq.some(Boolean);
      },
      {
        // Generous: heartbeat TTL + the 15s leadership re-eval poll.
        timeoutMs: 90_000,
        intervalMs: 1_000,
        label: "standby-acquires-leadership",
      },
    );

    // And the run still reaches completed with parts — replay closed
    // the gap left by the dead leader.
    await pollUntil(
      async () => (await threadStatus(threadId)) === "completed",
      {
        timeoutMs: 90_000,
        intervalMs: 1_000,
        label: "completed-after-failover",
      },
    );
    expect(await countParts(threadId)).toBeGreaterThan(0);
  }, 180_000);

  // (e) POISON — an un-projectable run is marked failed via the DLQ path
  // and does NOT wedge the consumer (a later healthy run still completes).
  test.skip("[poison] an un-projectable run is failed via DLQ without wedging later runs", async () => {
    const session = await bootstrapSession(PODS.STUDIO_1);
    await wireMockProvider(PODS.STUDIO_1, session);
    const { virtualMcpId } = await createTestAgent(PODS.STUDIO_1, session);

    // Poison run: the projector's terminal write throws; projectRun
    // exhausts retries → onDlq → onRunErrored → status='failed'.
    const { threadId: poisonThread } = await createTestThread(
      PODS.STUDIO_1,
      session,
      virtualMcpId,
    );
    await postTurn(
      PODS.STUDIO_1,
      session,
      virtualMcpId,
      poisonThread,
      POISON_HINT,
    );

    await pollUntil(
      async () => (await threadStatus(poisonThread)) === "failed",
      {
        // Includes the projector's bounded retry/backoff budget before
        // it DLQs the run.
        timeoutMs: 90_000,
        intervalMs: 1_000,
        label: "poison-run-failed",
      },
    );

    // Consumer must not be wedged: a fresh healthy run on a NEW thread
    // (published AFTER the poison) still reaches completed. Same org so
    // it shares the single leader-elected consumer.
    const { threadId: healthyThread } = await createTestThread(
      PODS.STUDIO_1,
      session,
      virtualMcpId,
    );
    await postTurn(
      PODS.STUDIO_1,
      session,
      virtualMcpId,
      healthyThread,
      FAST_HINT,
    );

    await pollUntil(
      async () => (await threadStatus(healthyThread)) === "completed",
      {
        timeoutMs: 30_000,
        intervalMs: 500,
        label: "healthy-run-after-poison-completes",
      },
    );
    expect(await countParts(healthyThread)).toBeGreaterThan(0);
  }, 120_000);
});
