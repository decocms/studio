// packages/e2e/tests/decopilot-thread-queue.spec.ts
/**
 * E2E: the thread-queue endpoints.
 *
 * ## Wire contract (apps/mesh/src/api/routes/decopilot/routes.ts +
 * apps/mesh/src/dispatch-queue/thread-gate-queue.ts)
 *
 *   GET  /api/:org/decopilot/queue/:threadId
 *     → 200 { items: [{ workflowId, messageId, status: "running"|"queued",
 *              enqueuedAt, source?, text, hasAttachments }] }
 *     Gate workflow ids are `thread-run:<threadId>:<messageId>`. The PENDING
 *     row is the running head; ENQUEUED rows are the queued tail, oldest
 *     first. `text`/`hasAttachments` are hydrated server-side from the
 *     item's persisted `thread_message_parts` (`foldQueueHydration`,
 *     `apps/mesh/src/api/routes/decopilot/queue-text.ts`) — never carried on
 *     the durable gate input, which stays content-free.
 *
 *   POST /api/:org/decopilot/queue/:threadId/cancel/:workflowId
 *     → 202 { cancelled: true } | 404 (not pending for this thread)
 *     Cancelling the RUNNING head runs the full run-cancel teardown (same as
 *     the stop endpoint below) — the queue then continues with the next
 *     ENQUEUED item ("run now"). Cancelling a QUEUED item instead deletes
 *     its message's part rows server-side, so the bubble does not
 *     resurrect on reload. This is also the first half of an "edit": the
 *     tray's `editQueuedMessage` cancels the original, then re-POSTs the
 *     edited text as a brand-new message id (DBOS workflow ids are
 *     once-ever), re-enqueuing it at the queue TAIL.
 *
 *   POST /api/:org/decopilot/cancel/:threadId
 *     → 202 { cancelled: true, async: true } (always)
 *     Cancels the active run AND any PENDING gate head (frees the
 *     partition). ENQUEUED items are left intact so the queue can proceed
 *     with the next one ("stop" == "run now" from the head's perspective).
 *
 * ## Two setup styles
 *
 * The ownership/listing/404 contract tests below seed `dbos.workflow_status`
 * rows directly (`seedGate`) — cheap, and enough to pin the pure read/guard
 * behavior.
 *
 * The scenario tests below (brief Step 2) need a REAL running turn (A) with
 * a REAL queued turn (B) behind it, so the assertions exercise the live
 * queue promotion machinery (DBOS dequeuing the ENQUEUED item once the
 * PENDING head's partition slot frees) rather than just static listing.
 * This mirrors `decopilot-fence-queueing.spec.ts`: a fake tunnel-link daemon
 * claims turn A's work item but withholds its relay, holding A genuinely
 * PENDING for as long as the test needs (deterministic, not a timing race)
 * while B is POSTed on the same thread and parks ENQUEUED behind A's
 * partition slot (THREAD_GATE_PARTITION_CONCURRENCY = 1).
 */

import { expect, newApiContext, test } from "../fixtures/test";
import { signUpViaApi } from "../fixtures/auth-api";
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
// Synthetic-seed helpers (pure listing/ownership/404 contract — no live
// dispatch needed)
// ---------------------------------------------------------------------------

/** Create a real agent (virtual MCP) + thread row; returns both ids. */
async function createAgentAndThread(
  api: APIRequestContext,
  orgSlug: string,
): Promise<{ agentId: string; threadId: string }> {
  const agent = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title: "E2E Thread Queue Agent",
        connections: [],
        status: "active",
        pinned: false,
      },
    },
  );
  const thread = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_THREADS_CREATE",
    {
      data: { virtual_mcp_id: agent.item.id, title: "E2E Thread Queue Thread" },
    },
  );
  return { agentId: agent.item.id, threadId: thread.item.id };
}

/**
 * Seed a thread-gate workflow_status row directly (DBOS-aware fixture). `inputs`
 * MUST be the DBOS serialization envelope {"json":[<context>]} so
 * listWorkflows({loadInput:true}) can parse it. Column set matches
 * decopilot-projector-dbos.spec.ts conventions.
 */
async function seedGate(
  db: {
    query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
  },
  threadId: string,
  o: { id: string; status: "PENDING" | "ENQUEUED"; at: number; text: string },
): Promise<string> {
  const wfId = `thread-run:${threadId}:${o.id}`;
  const ctx = {
    threadId,
    request: {
      messages: [
        { id: o.id, role: "user", parts: [{ type: "text", text: o.text }] },
      ],
    },
    source: "user-message",
  };
  await db.query(
    `INSERT INTO dbos.workflow_status
       (workflow_uuid, status, name, class_name, config_name, queue_name,
        executor_id, application_version, application_id, recovery_attempts,
        priority, created_at, updated_at, inputs)
     VALUES ($1,$2,'threadGateWorkflow','','','thread-gate',
        'seed-exec','seed-version','seed-app',0,0,$3,$3,$4)`,
    [wfId, o.status, String(o.at), JSON.stringify({ json: [ctx] })],
  );
  return wfId;
}

test("stop cancels a stuck PENDING gate head (frees the partition slot)", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  const api = page.context().request;
  const db = await connectDevDb();

  try {
    const { threadId } = await createAgentAndThread(api, orgSlug);

    // Arrange: a deploy-stranded head holding the slot.
    const wfId = await seedGate(db, threadId, {
      id: "stuck-head",
      status: "PENDING",
      at: Date.now(),
      text: "stuck",
    });

    // Act: hit the stop endpoint.
    const res = await api.post(`/api/${orgSlug}/decopilot/cancel/${threadId}`);
    expect(res.status()).toBe(202);

    // Assert: the gate head is now CANCELLED (slot freed).
    const { rows } = await db.query(
      `SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1`,
      [wfId],
    );
    expect((rows[0] as { status: string }).status).toBe("CANCELLED");
  } finally {
    await db.end();
  }
});

test("GET queue lists PENDING + ENQUEUED gate messages, oldest first", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  const api = page.context().request;
  const db = await connectDevDb();

  try {
    const { threadId } = await createAgentAndThread(api, orgSlug);

    await seedGate(db, threadId, {
      id: "head",
      status: "PENDING",
      at: 1000,
      text: "running one",
    });
    await seedGate(db, threadId, {
      id: "q2",
      status: "ENQUEUED",
      at: 3000,
      text: "second",
    });
    await seedGate(db, threadId, {
      id: "q1",
      status: "ENQUEUED",
      at: 2000,
      text: "first",
    });

    const res = await api.get(`/api/${orgSlug}/decopilot/queue/${threadId}`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ messageId: string; status: string }>;
    };
    expect(body.items.map((i) => i.messageId)).toEqual(["head", "q1", "q2"]);
    expect(body.items[0]).toMatchObject({ status: "running" });
    expect(body.items[1]).toMatchObject({ status: "queued" });
    expect(body.items[2]).toMatchObject({ status: "queued" });
  } finally {
    await db.end();
  }
});

test("GET queue 403s for a non-owner", async ({ authedPage, playwright }) => {
  const { page, orgSlug } = authedPage;
  const ownerApi = page.context().request;

  // Create a thread owned by the primary user.
  const { threadId } = await createAgentAndThread(ownerApi, orgSlug);

  // A second user who has no membership in orgSlug.
  const otherCtx = await newApiContext(playwright);
  await signUpViaApi(otherCtx);

  try {
    // TODO(e2e-hardening): this proves a NON-MEMBER gets 403 (org-membership
    // middleware). The owner-only guard (validateThreadOwnership: created_by !=
    // userId) for a non-owner who IS a member of the same org is not yet
    // covered — add a second org member via an invite/accept fixture and assert
    // 403 on another member's thread when this suite runs against real infra.
    // The other user tries to read the owner's thread queue — should 403.
    const res = await otherCtx.get(
      `/api/${orgSlug}/decopilot/queue/${threadId}`,
    );
    expect(res.status()).toBe(403);
  } finally {
    await otherCtx.dispose();
  }
});

test("POST cancel removes a queued item", async ({ authedPage }) => {
  const { page, orgSlug } = authedPage;
  const api = page.context().request;
  const db = await connectDevDb();

  try {
    const { threadId } = await createAgentAndThread(api, orgSlug);

    const wfId = await seedGate(db, threadId, {
      id: "to-cancel",
      status: "ENQUEUED",
      at: Date.now(),
      text: "x",
    });

    const res = await api.post(
      `/api/${orgSlug}/decopilot/queue/${threadId}/cancel/${encodeURIComponent(wfId)}`,
    );
    expect(res.status()).toBe(202);
    expect(await res.json()).toEqual({ cancelled: true });

    const { rows } = await db.query(
      `SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1`,
      [wfId],
    );
    expect((rows[0] as { status: string }).status).toBe("CANCELLED");
  } finally {
    await db.end();
  }
});

test("POST cancel 404s for a workflowId scoped to another thread", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  const api = page.context().request;

  const { threadId } = await createAgentAndThread(api, orgSlug);

  const foreign = encodeURIComponent("thread-run:someone-else:msg-1");
  const res = await api.post(
    `/api/${orgSlug}/decopilot/queue/${threadId}/cancel/${foreign}`,
  );
  expect(res.status()).toBe(404);
});

// ---------------------------------------------------------------------------
// Live-overlap helpers (real dispatch via a fake tunnel-link daemon) — mirror
// decopilot-fence-queueing.spec.ts's conventions.
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

/** Count a message's persisted part rows directly — the storage-layer proof
 *  that `deleteMessageParts` actually ran (not just that the read path hides
 *  it). */
async function fetchMessagePartsCount(
  db: Db,
  threadId: string,
  messageId: string,
): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM thread_message_parts WHERE thread_id = $1 AND message_id = $2`,
    [threadId, messageId],
  );
  return Number(rows[0]?.count ?? "0");
}

async function fetchGateWorkflowStatus(
  db: Db,
  workflowId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ status: string }>(
    `SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1`,
    [workflowId],
  );
  return rows[0]?.status ?? null;
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
        title: "Thread-queue E2E Agent",
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

function postMessage(
  api: APIRequestContext,
  orgSlug: string,
  agentId: string,
  threadId: string,
  messageId: string,
  messageText: string,
) {
  return api.post(`/api/${orgSlug}/decopilot/threads/${threadId}/messages`, {
    data: {
      messages: [
        {
          id: messageId,
          role: "user",
          parts: [{ type: "text", text: messageText }],
        },
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

interface WorkItemLike {
  runId: string;
  threadId: string;
  runFenceToken: string;
}

/**
 * Trigger a dispatch by POSTing a user message with an explicit id (so the
 * gate workflow id and persisted message id are known up front), then wait
 * for the tunnel daemon to receive the matching work item. Returns the runId
 * + the work item.
 */
async function dispatchAndClaimWorkItem(
  api: APIRequestContext,
  orgSlug: string,
  agentId: string,
  threadId: string,
  daemon: TunnelLinkDaemon,
  messageId: string,
  messageText: string,
): Promise<{ runId: string; workItem: WorkItemLike }> {
  const dispatchRes = await postMessage(
    api,
    orgSlug,
    agentId,
    threadId,
    messageId,
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
 *  the DB / read path for durable effects. */
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

// Per-test budget: up to two dispatch+relay round trips (one held open, one
// queued/promoted) plus each turn's own long-poll wait for its work item.
const CASE_TIMEOUT_MS = 150_000;
const POLL_OPTS = { timeout: 20_000, intervals: [250, 500, 1000, 2000] };

test.describe("thread queue — live overlap (running head + queued tail)", () => {
  test("GET /queue shows the running head and queued tail with correct messageIds", async ({
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

      const messageIdA = `queue-vis-a-${Date.now()}`;
      const turnA = await dispatchAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        messageIdA,
        "Turn A — hold please.",
      );

      const messageIdB = `queue-vis-b-${Date.now()}`;
      const textB = "Turn B — queued.";
      const postB = await postMessage(
        api,
        orgSlug,
        agentId,
        threadId,
        messageIdB,
        textB,
      );
      expect(postB.status()).toBe(202);

      // ── The contract assertion: while A runs and B waits, GET /queue
      // surfaces both — the running head and the queued tail — keyed by
      // messageId, hydrated with the persisted turn's text.
      const res = await api.get(`/api/${orgSlug}/decopilot/queue/${threadId}`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as {
        items: Array<{
          workflowId: string;
          messageId: string;
          status: string;
          enqueuedAt: number;
          text: string;
          hasAttachments: boolean;
        }>;
      };
      expect(body.items).toHaveLength(2);
      const running = body.items.find((i) => i.status === "running");
      const queued = body.items.find((i) => i.status === "queued");
      expect(running?.messageId).toBe(messageIdA);
      expect(running?.workflowId).toBe(`thread-run:${threadId}:${messageIdA}`);
      expect(queued?.messageId).toBe(messageIdB);
      expect(queued?.workflowId).toBe(`thread-run:${threadId}:${messageIdB}`);
      // ── Hydration proof: the queued item's `text` is the persisted concat
      // of its text parts (folded server-side from `thread_message_parts`,
      // not carried on the durable gate input) and it has no attachments.
      expect(queued?.text).toBe(textB);
      expect(queued?.hasAttachments).toBe(false);

      // ── Drain both turns so no gate workflow is left running past this
      // test (hygiene: a live PENDING workflow left dangling would keep
      // polling forever).
      const markerA = `queue-vis-marker-a-${Date.now()}`;
      const relayA = buildTurnRelayBody({
        messageId: `msg_${messageIdA}`,
        text: markerA,
      });
      await relay(turnA.runId, turnA.workItem.runFenceToken, relayA.body);
      await expect(async () => {
        expect(await fetchThreadStatus(db, threadId)).toBe("completed");
      }).toPass(POLL_OPTS);

      const workItemB = await daemon.nextWorkItem(threadId, {
        timeoutMs: 35_000,
      });
      const markerB = `queue-vis-marker-b-${Date.now()}`;
      const relayB = buildTurnRelayBody({
        messageId: `msg_${messageIdB}`,
        text: markerB,
      });
      await relay(threadId, workItemB.runFenceToken, relayB.body);
      await expect(async () => {
        expect(await fetchThreadStatus(db, threadId)).toBe("completed");
        const items = await listMessages(api, orgSlug, threadId);
        const assistantTexts = items
          .filter((m) => m.role === "assistant")
          .map((m) => JSON.stringify(m.parts));
        expect(assistantTexts.some((t) => t.includes(markerB))).toBe(true);

        // ── Queue-ordering regression (Fix A): the durable projector anchors
        // each assistant reply's `created_at` to its OWN request message's
        // max, not the run-wide max — so A's reply sorts immediately after
        // A's user message, never after B's later-queued user message (the
        // pre-fix bug produced u1,u2,a1,a2 instead of u1,a1,u2,a2). Assert
        // the full interleaved order via the same folded read path the chat
        // UI renders from.
        expect(items.map((m) => m.id)).toEqual([
          messageIdA,
          `msg_${messageIdA}`,
          messageIdB,
          `msg_${messageIdB}`,
        ]);
      }).toPass(POLL_OPTS);
    } finally {
      await daemon?.close();
      await db.end();
    }
  });

  test("queue-cancel on a QUEUED turn deletes its message parts (no resurrection)", async ({
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

      const messageIdA = `remove-a-${Date.now()}`;
      const turnA = await dispatchAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        messageIdA,
        "Turn A — hold please.",
      );

      const messageIdB = `remove-b-${Date.now()}`;
      const postB = await postMessage(
        api,
        orgSlug,
        agentId,
        threadId,
        messageIdB,
        "Turn B — will be removed.",
      );
      expect(postB.status()).toBe(202);

      // Sanity: B's user turn is persisted synchronously at POST time, before
      // the gate even attempts to dispatch it.
      const beforeCancel = await listMessages(api, orgSlug, threadId);
      expect(beforeCancel.some((m) => m.id === messageIdB)).toBe(true);
      expect(
        await fetchMessagePartsCount(db, threadId, messageIdB),
      ).toBeGreaterThan(0);

      // ── Remove B from the queue via the queue-cancel endpoint.
      const wfIdB = `thread-run:${threadId}:${messageIdB}`;
      const cancelRes = await api.post(
        `/api/${orgSlug}/decopilot/queue/${threadId}/cancel/${encodeURIComponent(wfIdB)}`,
      );
      expect(cancelRes.status()).toBe(202);
      expect(await cancelRes.json()).toEqual({ cancelled: true });

      // The delete is awaited server-side before the 202, so it must already
      // be gone — both at the storage layer and via a fresh read.
      expect(await fetchMessagePartsCount(db, threadId, messageIdB)).toBe(0);
      const rightAfterCancel = await listMessages(api, orgSlug, threadId);
      expect(rightAfterCancel.some((m) => m.id === messageIdB)).toBe(false);

      // ── Let A finish normally.
      const markerA = `remove-marker-a-${Date.now()}`;
      const relayA = buildTurnRelayBody({
        messageId: `msg_${messageIdA}`,
        text: markerA,
      });
      await relay(turnA.runId, turnA.workItem.runFenceToken, relayA.body);
      await expect(async () => {
        expect(await fetchThreadStatus(db, threadId)).toBe("completed");
      }).toPass(POLL_OPTS);

      // ── THE CONTRACT ASSERTION: a fresh GET after A completes still does
      // not show B — it must not resurrect (e.g. via a stray replay of its
      // originally-persisted parts).
      const afterACompletes = await listMessages(api, orgSlug, threadId);
      expect(afterACompletes.some((m) => m.id === messageIdB)).toBe(false);
      expect(await fetchMessagePartsCount(db, threadId, messageIdB)).toBe(0);
    } finally {
      await daemon?.close();
      await db.end();
    }
  });

  test("editing a queued turn cancels the original and requeues the edit at the tail (fresh id, B's text never lands)", async ({
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

      const messageIdA = `edit-a-${Date.now()}`;
      const turnA = await dispatchAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        messageIdA,
        "Turn A — hold please.",
      );

      // Queue B behind A with its ORIGINAL text.
      const messageIdB = `edit-b-${Date.now()}`;
      const originalTextB = "Turn B — original (will be edited).";
      const postB = await postMessage(
        api,
        orgSlug,
        agentId,
        threadId,
        messageIdB,
        originalTextB,
      );
      expect(postB.status()).toBe(202);

      // ── Act 1: the client's `editQueuedMessage` cancels the original turn
      // FIRST, awaited, via the per-item queue-cancel endpoint — this is the
      // API-level composition the tray drives.
      const wfIdB = `thread-run:${threadId}:${messageIdB}`;
      const cancelRes = await api.post(
        `/api/${orgSlug}/decopilot/queue/${threadId}/cancel/${encodeURIComponent(wfIdB)}`,
      );
      expect(cancelRes.status()).toBe(202);
      expect(await cancelRes.json()).toEqual({ cancelled: true });

      // B's parts are deleted (awaited server-side before the 202) and its
      // gate workflow has settled to CANCELLED.
      expect(await fetchMessagePartsCount(db, threadId, messageIdB)).toBe(0);
      expect(await fetchGateWorkflowStatus(db, wfIdB)).toBe("CANCELLED");
      const afterCancel = await listMessages(api, orgSlug, threadId);
      expect(afterCancel.some((m) => m.id === messageIdB)).toBe(false);

      // ── Act 2: re-POST the edited text as a FRESH message id (B2) — DBOS
      // workflow ids are once-ever, so an edit can never reuse B's id; this
      // mirrors `editQueuedMessage`'s re-enqueue-at-the-tail behavior.
      const messageIdB2 = `edit-b2-${Date.now()}`;
      const editedTextB2 = "Turn B — edited (final).";
      const postB2 = await postMessage(
        api,
        orgSlug,
        agentId,
        threadId,
        messageIdB2,
        editedTextB2,
      );
      expect(postB2.status()).toBe(202);
      const wfIdB2 = `thread-run:${threadId}:${messageIdB2}`;

      // B2 parks ENQUEUED behind A's still-held partition slot, exactly like
      // any fresh queued turn would — and B no longer appears at all.
      const queueAfterB2 = await api.get(
        `/api/${orgSlug}/decopilot/queue/${threadId}`,
      );
      const queueBodyAfterB2 = (await queueAfterB2.json()) as {
        items: Array<{ messageId: string; status: string; text: string }>;
      };
      const b2Item = queueBodyAfterB2.items.find(
        (i) => i.messageId === messageIdB2,
      );
      expect(b2Item?.status).toBe("queued");
      expect(b2Item?.text).toBe(editedTextB2);
      expect(
        queueBodyAfterB2.items.some((i) => i.messageId === messageIdB),
      ).toBe(false);

      // ── Drain A, then let B2 dequeue and run for real.
      const markerA = `edit-marker-a-${Date.now()}`;
      const relayA = buildTurnRelayBody({
        messageId: `msg_${messageIdA}`,
        text: markerA,
      });
      await relay(turnA.runId, turnA.workItem.runFenceToken, relayA.body);
      await expect(async () => {
        expect(await fetchThreadStatus(db, threadId)).toBe("completed");
      }).toPass(POLL_OPTS);

      const workItemB2 = await daemon.nextWorkItem(threadId, {
        timeoutMs: 35_000,
      });
      const markerB2 = `edit-marker-b2-${Date.now()}`;
      const relayB2 = buildTurnRelayBody({
        messageId: `msg_${messageIdB2}`,
        text: markerB2,
      });
      await relay(threadId, workItemB2.runFenceToken, relayB2.body);

      // ── THE CONTRACT ASSERTION: the final read shows B2's edited text —
      // never B's original — and both gate workflows have settled to their
      // expected terminal statuses.
      await expect(async () => {
        expect(await fetchThreadStatus(db, threadId)).toBe("completed");
        const items = await listMessages(api, orgSlug, threadId);
        expect(items.some((m) => m.id === messageIdB)).toBe(false);
        expect(items.some((m) => m.id === messageIdB2)).toBe(true);
        const userTexts = items
          .filter((m) => m.role === "user")
          .map((m) => JSON.stringify(m.parts));
        expect(userTexts.some((t) => t.includes(editedTextB2))).toBe(true);
        expect(userTexts.some((t) => t.includes(originalTextB))).toBe(false);
        const assistantTexts = items
          .filter((m) => m.role === "assistant")
          .map((m) => JSON.stringify(m.parts));
        expect(assistantTexts.some((t) => t.includes(markerB2))).toBe(true);
        expect(await fetchGateWorkflowStatus(db, wfIdB)).toBe("CANCELLED");
        expect(await fetchGateWorkflowStatus(db, wfIdB2)).toBe("SUCCESS");
      }).toPass(POLL_OPTS);
    } finally {
      await daemon?.close();
      await db.end();
    }
  });

  test("cancel-current promotes the queued turn — the current run ends non-completed, the queued turn completes", async ({
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

      const messageIdA = `runnow-a-${Date.now()}`;
      await dispatchAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        messageIdA,
        "Turn A — hold please.",
      );
      const wfIdA = `thread-run:${threadId}:${messageIdA}`;

      const messageIdB = `runnow-b-${Date.now()}`;
      const postB = await postMessage(
        api,
        orgSlug,
        agentId,
        threadId,
        messageIdB,
        "Turn B — should run next.",
      );
      expect(postB.status()).toBe(202);

      // ── Act: cancel the CURRENT run (the "run now"/stop endpoint, not the
      // per-item queue-cancel).
      const cancelRes = await api.post(
        `/api/${orgSlug}/decopilot/cancel/${threadId}`,
      );
      expect(cancelRes.status()).toBe(202);
      expect(await cancelRes.json()).toEqual({ cancelled: true, async: true });

      // ── A ends non-completed: its OWN gate workflow was cancelled, not
      // finished. Asserted at the workflow level (not `threads.status`,
      // which B's turn will soon overwrite) so it can't race B's own writes.
      await expect(async () => {
        expect(await fetchGateWorkflowStatus(db, wfIdA)).toBe("CANCELLED");
      }).toPass(POLL_OPTS);

      // ── B, left ENQUEUED (queue-continues semantics), now dequeues once
      // A's partition slot frees and dispatches for real.
      const workItemB = await daemon.nextWorkItem(threadId, {
        timeoutMs: 35_000,
      });
      expect(workItemB.threadId).toBe(threadId);

      const markerB = `runnow-marker-b-${Date.now()}`;
      const relayB = buildTurnRelayBody({
        messageId: `msg_${messageIdB}`,
        text: markerB,
      });
      await relay(threadId, workItemB.runFenceToken, relayB.body);

      await expect(async () => {
        expect(await fetchThreadStatus(db, threadId)).toBe("completed");
        const items = await listMessages(api, orgSlug, threadId);
        expect(items.some((m) => m.id === messageIdB)).toBe(true);
        const assistantTexts = items
          .filter((m) => m.role === "assistant")
          .map((m) => JSON.stringify(m.parts));
        expect(assistantTexts.some((t) => t.includes(markerB))).toBe(true);
      }).toPass(POLL_OPTS);
    } finally {
      await daemon?.close();
      await db.end();
    }
  });

  test("cancel-current on a lone running turn frees the partition for a new message", async ({
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

      // A runs ALONE — no queued turn behind it.
      const messageIdA = `stop-a-${Date.now()}`;
      await dispatchAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        messageIdA,
        "Turn A — hold please.",
      );

      const cancelRes = await api.post(
        `/api/${orgSlug}/decopilot/cancel/${threadId}`,
      );
      expect(cancelRes.status()).toBe(202);
      expect(await cancelRes.json()).toEqual({ cancelled: true, async: true });

      // ── The thread reaches a terminal status — not stuck `in_progress`.
      await expect(async () => {
        const status = await fetchThreadStatus(db, threadId);
        expect(status).not.toBe("in_progress");
        expect(status).toBe("failed");
      }).toPass(POLL_OPTS);

      // ── THE CONTRACT ASSERTION: the partition was freed — a brand-new
      // message C posts and completes normally afterward.
      const messageIdC = `stop-c-${Date.now()}`;
      const turnC = await dispatchAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        messageIdC,
        "Turn C — after stop.",
      );

      const markerC = `stop-marker-c-${Date.now()}`;
      const relayC = buildTurnRelayBody({
        messageId: `msg_${messageIdC}`,
        text: markerC,
      });
      await relay(turnC.runId, turnC.workItem.runFenceToken, relayC.body);

      await expect(async () => {
        expect(await fetchThreadStatus(db, threadId)).toBe("completed");
        const items = await listMessages(api, orgSlug, threadId);
        expect(items.some((m) => m.id === messageIdC)).toBe(true);
        const assistantTexts = items
          .filter((m) => m.role === "assistant")
          .map((m) => JSON.stringify(m.parts));
        expect(assistantTexts.some((t) => t.includes(markerC))).toBe(true);
      }).toPass(POLL_OPTS);
    } finally {
      await daemon?.close();
      await db.end();
    }
  });
});

test("POST keeps message content (and attachments) out of the DBOS workflow input, externalized into parts", async ({
  authedPage,
}) => {
  // Object storage (S3 + org-fs) must be available for the studio-storage
  // assertion to hold: uploadFileParts only materializes when ctx.orgFs is
  // present, which requires a real S3-backed objectStorage. Skip on plain
  // local dev without MinIO.
  test.skip(
    !(
      process.env.S3_ENDPOINT &&
      process.env.S3_BUCKET &&
      process.env.S3_ACCESS_KEY_ID &&
      process.env.S3_SECRET_ACCESS_KEY
    ),
    "requires S3 env (S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY); see e2e.yml MinIO setup",
  );

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

    // A tiny 1×1 PNG as a data: URL — represents a user-attached image.
    const tinyPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const messageId = `img-${Date.now()}`;

    // Same wire shape as `postMessage`, plus the data: file part. The
    // contracts under test are harness-agnostic (`uploadFileParts` +
    // `emitRequestMessage` run unconditionally in the POST handler before
    // enqueue) — but the POST itself must route via the suite's claude-code +
    // user-desktop pattern: the decopilot harness resolves a model TIER at
    // POST time, which 400s (TierUnavailableError) in this providerless
    // test org.
    const res = await api.post(
      `/api/${orgSlug}/decopilot/threads/${threadId}/messages`,
      {
        data: {
          messages: [
            {
              id: messageId,
              role: "user",
              parts: [
                { type: "text", text: "describe this" },
                {
                  type: "file",
                  url: tinyPng,
                  mediaType: "image/png",
                  filename: "a.png",
                },
              ],
            },
          ],
          agent: { id: agentId },
          branch: "ephemeral",
          temperature: 0.5,
          harnessId: "claude-code",
          sandboxProviderKind: "user-desktop",
        },
        headers: { "content-type": "application/json" },
      },
    );
    expect(res.status()).toBe(202);
    const { taskId: runId } = (await res.json()) as { taskId: string };
    expect(runId).toBeTruthy();

    // The gate actually dispatched — the fake daemon received the work item.
    const workItem = await daemon.nextWorkItem(runId);
    expect(workItem.threadId).toBe(threadId);

    // ── CONTRACT 1: the durable gate input is content-free/small. The
    // `DurableDispatchRunInput` carries only config + the messageId — no
    // `messages`/parts at all (the gate re-loads history from the DB at
    // dispatch) — so neither the raw base64 blob nor any parts array may
    // appear in the persisted workflow input. This is the contract that
    // superseded "externalize attachments INTO the input": there is no
    // message content in the input to externalize anymore.
    // `inputs` is a TEXT column (the {"json":[ctx]} envelope) — read as string.
    const wfId = `thread-run:${threadId}:${messageId}`;
    const { rows } = await db.query(
      `SELECT inputs FROM dbos.workflow_status WHERE workflow_uuid = $1`,
      [wfId],
    );
    const serialized = String(
      (rows[0] as { inputs: string } | undefined)?.inputs ?? "",
    );
    expect(serialized).not.toContain("data:image/png;base64,");
    expect(serialized).not.toContain('"parts"');

    // ── CONTRACT 2: the attachment IS externalized — in the PERSISTED PARTS.
    // `uploadFileParts` materializes the data: URL to object storage BEFORE
    // `emitRequestMessage` persists the user turn (both synchronous in the
    // POST handler), so the stored file part must carry the stable
    // `studio-storage:` ref, never the raw base64 blob.
    const { rows: partRows } = await db.query<{ p: string }>(
      `SELECT payload::text AS p
         FROM thread_message_parts
        WHERE thread_id = $1
          AND message_id = $2`,
      [threadId, messageId],
    );
    expect(partRows.length).toBeGreaterThan(0);
    const combinedParts = partRows.map((r) => r.p).join("\n");
    expect(combinedParts).not.toContain("data:image/png;base64,");
    expect(combinedParts).toContain("studio-storage:");

    // ── CONTRACT 3: the turn is still claimable (daemon has the work item,
    // relay hasn't landed yet) — GET /queue must hydrate `hasAttachments`
    // from the persisted file part folded above, so the tray can hide the
    // Edit action for this turn (edit is text-only by design). This lone
    // turn is the gate's PENDING head, so it surfaces with status "running"
    // rather than "queued" — but it is the same hydration path a genuinely
    // queued (ENQUEUED) attachment turn would go through.
    const queueRes = await api.get(
      `/api/${orgSlug}/decopilot/queue/${threadId}`,
    );
    expect(queueRes.status()).toBe(200);
    const queueBody = (await queueRes.json()) as {
      items: Array<{ messageId: string; hasAttachments: boolean }>;
    };
    const queueItem = queueBody.items.find((i) => i.messageId === messageId);
    expect(queueItem?.hasAttachments).toBe(true);

    // Drain the turn to a terminal status so no PENDING gate workflow is
    // left dangling in the shared CI server process past this test.
    const marker = `externalize-marker-${Date.now()}`;
    const relayBody = buildTurnRelayBody({
      messageId: `msg_${messageId}`,
      text: marker,
    });
    await relay(runId, workItem.runFenceToken, relayBody.body);
    await expect(async () => {
      expect(await fetchThreadStatus(db, threadId)).toBe("completed");
    }).toPass(POLL_OPTS);
  } finally {
    await daemon?.close();
    await db.end();
  }
});
