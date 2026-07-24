/**
 * E2E: fence regression — a turn queued behind a running turn must not
 * strand the running turn's reply.
 *
 * ## The bug (fixed by commit "fix(decopilot): claim the run fence at gate
 * dispatch, not POST")
 *
 * `POST /messages` used to mint AND PERSIST a fresh `run_fence_token` (and
 * flip `threads.status` to `in_progress`) synchronously in the HTTP handler,
 * for every new turn — including one that would only be DISPATCHED later,
 * behind the per-thread gate queue (`THREAD_GATE_PARTITION_CONCURRENCY = 1`).
 * So a message B posted while turn A was still running clobbered A's live
 * fence in the DB well before A's consume step finished draining its stream.
 * The consume step's `shouldSkipProjection` guard compares the stream's
 * fence against the CURRENT `threads.run_fence_token`; once B's POST
 * overwrote it, A's own relayed chunks looked stale and were silently
 * dropped — no assistant message, no terminal status. Turn A's reply was
 * stranded even though it was the one actually running.
 *
 * The fix moves fence minting into `claimRunFenceForDispatch`, called from
 * `dispatchRunAndWaitStep` — i.e. only once a gate workflow actually HOLDS
 * the thread's partition slot. A queued message can no longer touch
 * `run_fence_token` until the running turn's entire gate workflow (dispatch
 * + consume) has returned.
 *
 * ## Scenario variant: sequential-overlap (not concurrent-race)
 *
 * Rather than racing two concurrent POSTs (timing-dependent and flaky), this
 * test drives a REAL dispatch for turn A and deliberately withholds its
 * relay completion — the fake tunnel daemon has received turn A's work item,
 * but we don't publish its chunks yet. This holds turn A genuinely
 * `in_progress` for as long as the test needs, giving a deterministic,
 * arbitrarily wide overlap window instead of a timing race. Turn B is then
 * POSTed on the SAME thread while A is still open. Because
 * `runId === threadId`, both turns share one `threads` row, so any POST-time
 * fence clobber would be immediately visible on that row.
 *
 * This mirrors `link-ingest.spec.ts`'s "second sequential turn" case (same
 * dispatch/claim/relay helpers, same daemon fixture) but overlaps the two
 * turns instead of completing A before B is even sent.
 */

import { sleep } from "@decocms/shared/std";
import { expect, test } from "../fixtures/test";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import {
  createTunnelLinkDaemon,
  type TunnelLinkDaemon,
} from "../fixtures/links-presence";
import { buildTurnRelayBody } from "../fixtures/relay-chunks";
import { publishRelayBody } from "../fixtures/relay-nats";
import { DEFAULT_THREAD_TITLE } from "@decocms/harness/decopilot/prompt-constants";
import type { APIRequestContext } from "@playwright/test";

// ---------------------------------------------------------------------------
// Shared helpers (mirror harness-conformance.spec.ts / link-ingest.spec.ts)
// ---------------------------------------------------------------------------

type Db = Awaited<ReturnType<typeof connectDevDb>>;

async function orgIdForSlug(db: Db, slug: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM "organization" WHERE slug = $1`,
    [slug],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`no organization row for slug ${slug}`);
  return id;
}

async function fetchThreadRow(
  db: Db,
  threadId: string,
): Promise<{ status: string | null; runFenceToken: string | null }> {
  const { rows } = await db.query<{
    status: string;
    run_fence_token: string | null;
  }>(`SELECT status, run_fence_token FROM threads WHERE id = $1`, [threadId]);
  return {
    status: rows[0]?.status ?? null,
    runFenceToken: rows[0]?.run_fence_token ?? null,
  };
}

async function fetchThreadStatus(
  db: Db,
  threadId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ status: string }>(
    `SELECT status FROM threads WHERE id = $1`,
    [threadId],
  );
  return rows[0]?.status ?? null;
}

async function fetchParts(
  db: Db,
  runId: string,
): Promise<Array<{ kind: string; role: string; payload: unknown }>> {
  const { rows } = await db.query<{
    kind: string;
    role: string;
    payload: unknown;
  }>(
    `SELECT kind, role, payload FROM thread_message_parts WHERE run_id = $1 ORDER BY seq`,
    [runId],
  );
  return rows;
}

/**
 * Create an agent (virtual MCP) + a v2 thread pinned to a user-desktop /
 * claude-code target so POST /messages routes to the pull gate (and its
 * per-thread queue) without per-request model resolution.
 */
async function createPullThread(
  api: APIRequestContext,
  db: Db,
  orgSlug: string,
  orgId: string,
): Promise<{ agentId: string; threadId: string }> {
  const agent = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title: "Fence-queueing E2E Agent",
        connections: [],
        status: "active",
        pinned: false,
      },
    },
  );
  const agentId = agent.item.id;

  const thread = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_THREADS_CREATE",
    { data: { virtual_mcp_id: agentId } },
  );
  const threadId = thread.item.id;

  await db.query(
    `UPDATE threads
     SET message_storage_version = 2,
         harness_id              = 'claude-code',
         sandbox_provider_kind   = 'user-desktop',
         title                   = $3
     WHERE id = $1
       AND organization_id = $2`,
    [threadId, orgId, DEFAULT_THREAD_TITLE],
  );

  return { agentId, threadId };
}

interface WorkItem {
  runId: string;
  threadId: string;
  orgId: string;
  userId: string;
  runFenceToken: string;
  harnessInput: Record<string, unknown>;
}

function postMessage(
  api: APIRequestContext,
  orgSlug: string,
  agentId: string,
  threadId: string,
  messageText: string,
) {
  return api.post(`/api/${orgSlug}/decopilot/threads/${threadId}/messages`, {
    data: {
      messages: [
        { role: "user", parts: [{ type: "text", text: messageText }] },
      ],
      agent: { id: agentId },
      branch: "ephemeral",
      temperature: 0.5,
      harnessId: "claude-code",
      sandboxProviderKind: "user-desktop",
    },
    headers: { "content-type": "application/json" },
  });
}

/**
 * Trigger a dispatch by POSTing a user message, then wait for the tunnel
 * daemon to receive the matching work item. Returns the runId + the work
 * item (whose runFenceToken the relay presents).
 */
async function dispatchAndClaimWorkItem(
  api: APIRequestContext,
  orgSlug: string,
  agentId: string,
  threadId: string,
  daemon: TunnelLinkDaemon,
  messageText: string,
): Promise<{ runId: string; workItem: WorkItem }> {
  const dispatchRes = await postMessage(
    api,
    orgSlug,
    agentId,
    threadId,
    messageText,
  );
  expect(dispatchRes.status()).toBe(202);
  const { taskId: runId } = (await dispatchRes.json()) as { taskId: string };
  expect(runId).toBeTruthy();

  const workItem = await daemon.nextWorkItem(runId);
  expect(workItem.runId).toBe(runId);
  expect(workItem.threadId).toBe(threadId);
  expect(typeof workItem.runFenceToken).toBe("string");
  expect(workItem.runFenceToken.length).toBeGreaterThan(0);

  return { runId, workItem };
}

/** Relay a canned NDJSON chunk body straight to the run's JetStream stream,
 *  exactly as the desktop daemon does. Persistence is async — callers poll
 *  the DB for durable effects. */
function relay(runId: string, fenceToken: string, body: string) {
  return publishRelayBody({ runId, fenceToken, body });
}

/** Read back the folded messages via the real v2 read-path tool. */
async function listMessages(
  api: APIRequestContext,
  orgSlug: string,
  threadId: string,
): Promise<Array<{ id: string; role: string; parts: unknown[] }>> {
  const result = await callSelfMcpTool<{
    items: Array<{ id: string; role: string; parts: unknown[] }>;
    totalCount: number;
  }>(api, orgSlug, "COLLECTION_THREAD_MESSAGES_LIST", { thread_id: threadId });
  return result.items;
}

// Per-test budget: 2 dispatch+relay round trips (one held open, one queued)
// plus the queued turn's own long-poll wait for its work item.
const CASE_TIMEOUT_MS = 150_000;

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test.describe("fence regression — queued turn does not strand the running turn's reply", () => {
  test("turn queued mid-run does not strand the running turn's reply", async ({
    authedPage,
  }) => {
    test.setTimeout(CASE_TIMEOUT_MS);
    const { page, orgSlug, user } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    let daemon: TunnelLinkDaemon | null = null;
    try {
      daemon = await createTunnelLinkDaemon(api, user.userId, ["claude-code"]);
      const orgId = await orgIdForSlug(db, orgSlug);
      const { agentId, threadId } = await createPullThread(
        api,
        db,
        orgSlug,
        orgId,
      );

      // ── Turn A: dispatch + claim its work item, but do NOT relay its
      // completion yet. This holds A genuinely `in_progress` for the whole
      // overlap window instead of racing two POSTs.
      const turnA = await dispatchAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        "Turn A — hold please.",
      );

      // Turn A is observably in progress: the gate's dispatch step claims
      // the fence + flips status to `in_progress` BEFORE publishing the work
      // item we just received, so both must already be visible.
      const rowDuringA = await fetchThreadRow(db, threadId);
      expect(rowDuringA.status).toBe("in_progress");
      expect(rowDuringA.runFenceToken).toBe(turnA.workItem.runFenceToken);

      // ── POST turn B while A is still running. Same thread → the
      // per-thread gate queue (concurrency=1) enqueues B behind A; B's
      // workflow won't attempt to claim a fence until A's ENTIRE gate
      // workflow (dispatch + consume) has returned.
      const postB = await postMessage(
        api,
        orgSlug,
        agentId,
        threadId,
        "Turn B — queued.",
      );
      expect(postB.status()).toBe(202);
      const { taskId: taskIdB } = (await postB.json()) as { taskId: string };
      expect(taskIdB).toBe(threadId);

      // ── THE REGRESSION ASSERTION: queueing B must not clobber A's live
      // fence/status. Before the fix, POST /messages minted+persisted a
      // fresh fence synchronously for every new message — including one
      // that would only dispatch later, behind the gate queue — stomping
      // the in-flight turn's fence and status. Give any (now-removed) async
      // clobber a moment to land before asserting it did NOT happen.
      await sleep(1_500);
      const rowAfterB = await fetchThreadRow(db, threadId);
      expect(rowAfterB.runFenceToken).toBe(turnA.workItem.runFenceToken);
      expect(rowAfterB.status).toBe("in_progress");

      // ── Relay turn A's completion. Pre-fix, A's fence would already have
      // been overwritten by B's POST, so the consume step's
      // `shouldSkipProjection` guard would silently drop this relay — no
      // assistant reply, no terminal status. That is the exact regression
      // this test pins.
      const markerA = `fence-e2e-turn-a-${Date.now()}`;
      const relayA = buildTurnRelayBody({
        messageId: `msg_fence_a_${Date.now()}`,
        text: markerA,
      });
      const ackA = await relay(
        turnA.runId,
        turnA.workItem.runFenceToken,
        relayA.body,
      );
      expect(ackA.lastSeq).toBe(relayA.lineCount);

      await expect(async () => {
        const parts = await fetchParts(db, turnA.runId);
        const assistantKinds = parts
          .filter((p) => p.role === "assistant")
          .map((p) => p.kind);
        expect(assistantKinds).toContain("text");
        expect(assistantKinds).toContain("finish");
        expect(JSON.stringify(parts)).toContain(markerA);
        expect(await fetchThreadStatus(db, threadId)).toBe("completed");
      }).toPass({ timeout: 20_000, intervals: [250, 500, 1000, 2000] });

      // ── Turn B, having been queued behind A, is now dispatched with a
      // FRESH fence once A's gate workflow fully returned.
      const workItemB = await daemon.nextWorkItem(threadId, {
        timeoutMs: 35_000,
      });
      expect(workItemB.threadId).toBe(threadId);
      expect(workItemB.runFenceToken).not.toBe(turnA.workItem.runFenceToken);

      const markerB = `fence-e2e-turn-b-${Date.now()}`;
      const relayB = buildTurnRelayBody({
        messageId: `msg_fence_b_${Date.now()}`,
        text: markerB,
      });
      const ackB = await relay(threadId, workItemB.runFenceToken, relayB.body);
      expect(ackB.lastSeq).toBe(relayB.lineCount);

      // ── Final assertions (the contract): A's reply exists (it must NOT
      // have vanished), the thread reached a terminal status (not stuck
      // `in_progress`), and B's reply also exists (the queue drained).
      await expect(async () => {
        const parts = await fetchParts(db, threadId);
        const serializedParts = JSON.stringify(parts);
        expect(serializedParts).toContain(markerA);
        expect(serializedParts).toContain(markerB);
        expect(await fetchThreadStatus(db, threadId)).toBe("completed");

        const items = await listMessages(api, orgSlug, threadId);
        const assistantTexts = items
          .filter((m) => m.role === "assistant")
          .map((m) => JSON.stringify(m.parts));
        expect(assistantTexts.some((t) => t.includes(markerA))).toBe(true);
        expect(assistantTexts.some((t) => t.includes(markerB))).toBe(true);
      }).toPass({ timeout: 20_000, intervals: [250, 500, 1000, 2000] });
    } finally {
      await daemon?.close();
      await db.end();
    }
  });
});
