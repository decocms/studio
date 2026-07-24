/**
 * E2E: direct-NATS chunk-relay ingest → per-run consume-step persistence.
 *
 * The desktop daemon runs a harness locally and publishes its raw output as
 * seq-numbered `RelayLine`s straight to the run's JetStream stream
 * `decopilot.stream.<runId>` (protocol v2; see `link-daemon/direct-nats-publisher.ts`).
 * Projection now happens inside the dispatch workflow's CONSUME STEP — the gate
 * that handled POST /messages mints the run fence, dispatches the work item to
 * the desktop link, and runs `consumeRunProjection` bound to the run's stream.
 * That step:
 *   1. Resolves the run's org (the consume step only runs for a dispatched run).
 *   2. Skips a stream whose fence differs from the run's current
 *      run_fence_token (`shouldSkipProjection`).
 *   3. Feeds the relayed chunks into the harness kernel (consumeHarnessStream),
 *      which commits parts via PartEmitter and transitions the run terminal.
 *
 * Because projection is now per-dispatch, these tests drive a REAL dispatch:
 * register a fake desktop daemon (tunnel link), POST /messages (→ 202 + the
 * gate publishes a work item and starts the consume step), claim the work item
 * to read its gate-minted fence, then relay the canned chunks with that fence.
 * Persistence is ASYNC — publishing returns once the lines are on the stream;
 * the consume step materializes parts + flips `threads.status` shortly after,
 * so these tests POLL the DB.
 *
 * This spec verifies the happy path (matching fence → parts land + status
 * completed), the stale-fence path (mismatched fence → zero parts), and the
 * full-prefix resend path (idempotent → parts land). The old HTTP route's
 * status-code contract (200/409/404/410) no longer exists; fence/ownership
 * enforcement now lives in the consume step and is asserted at the DB level.
 *
 * Wire format: one `{seq, event}\n` JSON line per DispatchSSEEvent, ending
 * with a `{type:"done"}` terminal line (see links/protocol/relay.ts).
 */

import { sleep } from "@decocms/shared/std";
import { expect, test } from "../fixtures/test";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import {
  createTunnelLinkDaemon,
  type TunnelLinkDaemon,
} from "../fixtures/links-presence";
import { publishRelayBody, publishRelayManual } from "../fixtures/relay-nats";
import { DEFAULT_THREAD_TITLE } from "@decocms/harness/decopilot/prompt-constants";
import type { APIRequestContext } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers (mirror harness-conformance.spec.ts)
// ---------------------------------------------------------------------------

type Db = Awaited<ReturnType<typeof connectDevDb>>;

/** Resolve the org id (not slug) for the given org slug. */
async function orgIdForSlug(db: Db, slug: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM "organization" WHERE slug = $1`,
    [slug],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`no organization row for slug ${slug}`);
  return id;
}

/**
 * Fetch the thread_message_parts rows for the given run (runId == threadId).
 */
async function fetchParts(
  db: Db,
  runId: string,
): Promise<Array<{ kind: string; payload: unknown; role: string }>> {
  const { rows } = await db.query<{
    kind: string;
    payload: unknown;
    role: string;
  }>(
    `SELECT kind, payload, role FROM thread_message_parts WHERE run_id = $1 ORDER BY seq`,
    [runId],
  );
  return rows;
}

/** Fetch the durable thread status. */
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

/**
 * Create an agent (virtual MCP) + a v2 thread pinned to a user-desktop /
 * claude-code target so POST /messages routes to the pull gate (and its
 * consume step) without per-request model resolution.
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
        title: "Link-ingest E2E Agent",
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

  // Pin the pull-transport columns. The dispatch route reads harness_id off
  // this row to route the work item to the daemon and start the consume step.
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
  messagesRef?: { url: string; bytes: number; sha256: string };
}

/**
 * Trigger a dispatch by POSTing a user message, then wait for the tunnel daemon
 * to receive the matching work item. Returns the runId + the work item (whose
 * runFenceToken the relay presents).
 */
async function dispatchAndClaimWorkItem(
  api: APIRequestContext,
  orgSlug: string,
  agentId: string,
  threadId: string,
  daemon: TunnelLinkDaemon,
  messageText: string,
): Promise<{ runId: string; workItem: WorkItem }> {
  const dispatchRes = await api.post(
    `/api/${orgSlug}/decopilot/threads/${threadId}/messages`,
    {
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
    },
  );
  expect(dispatchRes.status()).toBe(202);
  const { taskId: runId } = (await dispatchRes.json()) as { taskId: string };
  expect(runId).toBeTruthy();

  const workItem = await daemon.nextWorkItem(runId);
  expect(workItem.runId).toBe(runId);
  expect(workItem.threadId).toBe(threadId);
  expect(typeof workItem.runFenceToken).toBe("string");
  expect(workItem.runFenceToken.length).toBeGreaterThan(0);

  return { runId, workItem: workItem as unknown as WorkItem };
}

/**
 * Relay a canned NDJSON chunk body as the fake daemon: publish it straight to
 * the run's JetStream stream, exactly as the desktop daemon now does (the old
 * POST /chunks ingest route is gone). Persistence is async — callers poll the
 * DB for the consume step's durable effects.
 */
function relay(runId: string, fenceToken: string, body: string) {
  return publishRelayBody({ runId, fenceToken, body });
}

/**
 * Build a minimal NDJSON chunk-relay body carrying a single assistant turn:
 *   start → start-step → text-start → text-delta → text-end → finish-step → finish
 * followed by a terminal `done` line. Each line is a seq-numbered RelayLine,
 * exactly what the real daemon chunk relay streams (link-daemon/chunk-relay.ts).
 */
function buildRelayBody(messageId: string, text: string): string {
  const textId = `${messageId}-text-0`;
  const chunks: unknown[] = [
    { type: "start", messageId },
    { type: "start-step" },
    { type: "text-start", id: textId },
    { type: "text-delta", id: textId, delta: text },
    { type: "text-end", id: textId },
    { type: "finish-step" },
    { type: "finish" },
  ];
  const events: unknown[] = chunks.map((chunk) => ({
    type: "ui-message-chunk",
    chunk,
  }));
  events.push({ type: "done" });
  return `${events
    .map((event, i) => JSON.stringify({ seq: i + 1, event }))
    .join("\n")}\n`;
}

// Per-test budget: setup + dispatch + claim work item + relay + reads.
const CASE_TIMEOUT_MS = 130_000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("direct-NATS chunk relay ingest", () => {
  test("matching fence → parts land in thread_message_parts and run completes", async ({
    authedPage,
  }) => {
    test.setTimeout(CASE_TIMEOUT_MS);
    const { page, user, orgSlug } = authedPage;
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

      // Drive a real dispatch so the per-run consume step runs and binds the
      // run's stream; relay with the gate-minted fence the work item carries.
      const { runId, workItem } = await dispatchAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        "Reply 'ok'.",
      );

      const messageId = `msg_ingest_e2e_${Date.now()}`;
      const bodyText = `link-ingest-e2e-marker-${Date.now()}`;
      const relayBody = buildRelayBody(messageId, bodyText);

      await relay(runId, workItem.runFenceToken, relayBody);

      // Parts + terminal status are written by the async consume step (it
      // reconstructs the run from JetStream), so poll until they land: a text
      // part + finish anchor, and status 'completed'.
      await expect(async () => {
        const parts = await fetchParts(db, runId);
        expect(parts.length).toBeGreaterThanOrEqual(2);
        const kinds = parts.map((p) => p.kind);
        expect(kinds).toContain("text");
        expect(kinds).toContain("finish");
        expect(await fetchThreadStatus(db, runId)).toBe("completed");
      }).toPass({ timeout: 20_000, intervals: [250, 500, 1000, 2000] });
    } finally {
      await daemon?.close();
      await db.end();
    }
  });

  test("second sequential turn projects (not dropped by prior turn's terminal status)", async ({
    authedPage,
  }) => {
    // Regression: `runId === threadId`, so the run row (status) is shared across
    // every turn of a thread. The consume step's entry guard returns early on a
    // terminal status. Before the turn-start status reset in `setRunFence`, a
    // SECOND turn inherited the FIRST turn's `completed` status, so its consume
    // step short-circuited and the turn rendered "No response was generated".
    // Two real dispatch+relay turns on one thread must BOTH land their assistant
    // text — the second turn's marker is the assertion that catches the drop.
    test.setTimeout(CASE_TIMEOUT_MS);
    const { page, user, orgSlug } = authedPage;
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

      const hasTextMarker = (
        parts: Array<{ kind: string; payload: unknown }>,
        marker: string,
      ): boolean =>
        parts.some(
          (p) =>
            p.kind === "text" && JSON.stringify(p.payload).includes(marker),
        );

      // ── Turn 1 ──────────────────────────────────────────────────────────
      const turn1 = await dispatchAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        "First turn.",
      );
      const marker1 = `turn-1-marker-${Date.now()}`;
      await relay(
        turn1.runId,
        turn1.workItem.runFenceToken,
        buildRelayBody(`msg_turn1_${Date.now()}`, marker1),
      );
      await expect(async () => {
        expect(hasTextMarker(await fetchParts(db, turn1.runId), marker1)).toBe(
          true,
        );
        expect(await fetchThreadStatus(db, threadId)).toBe("completed");
      }).toPass({ timeout: 20_000, intervals: [250, 500, 1000, 2000] });

      // ── Turn 2 (same thread; prior status is now `completed`) ────────────
      const turn2 = await dispatchAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        "Second turn.",
      );
      // The gate must have minted a FRESH fence and re-armed the run to
      // `in_progress` (otherwise the consume entry guard drops this turn).
      expect(turn2.workItem.runFenceToken).not.toBe(
        turn1.workItem.runFenceToken,
      );
      const marker2 = `turn-2-marker-${Date.now()}`;
      await relay(
        turn2.runId,
        turn2.workItem.runFenceToken,
        buildRelayBody(`msg_turn2_${Date.now()}`, marker2),
      );
      // The bug-catching assertion: the SECOND turn's assistant text lands.
      await expect(async () => {
        const parts = await fetchParts(db, turn2.runId);
        expect(hasTextMarker(parts, marker2)).toBe(true);
        expect(await fetchThreadStatus(db, threadId)).toBe("completed");
      }).toPass({ timeout: 20_000, intervals: [250, 500, 1000, 2000] });

      // Both turns' markers persist (no cross-turn clobber).
      const finalParts = await fetchParts(db, turn2.runId);
      expect(hasTextMarker(finalParts, marker1)).toBe(true);
      expect(hasTextMarker(finalParts, marker2)).toBe(true);
    } finally {
      await daemon?.close();
      await db.end();
    }
  });

  test("mismatched fence → projector skips, zero parts land", async ({
    authedPage,
  }) => {
    // Drive a real dispatch (so the consume step actually runs), then relay
    // with a DIFFERENT (stale) fence — the consume step's shouldSkipProjection
    // must drop the whole stream. Without a real dispatch this would assert
    // "zero parts" trivially (nothing projects for an un-dispatched run).
    test.setTimeout(CASE_TIMEOUT_MS);
    const { page, user, orgSlug } = authedPage;
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

      const { runId } = await dispatchAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        "What number?",
      );

      const relayBody = buildRelayBody(
        `msg_stale_e2e_${Date.now()}`,
        "should not land",
      );

      // The run's fence is the gate-minted token; relaying a stale fence makes
      // the consume step SKIP this mismatched-fence stream — nothing commits.
      await relay(runId, `fence_stale_${Date.now()}`, relayBody);

      // Give the consume step a window to observe + skip, then assert no
      // ASSISTANT/relay parts landed. The user's own message parts persist on
      // dispatch; only the stale-fence relay must be dropped.
      await sleep(4_000);
      const parts = await fetchParts(db, runId);
      expect(parts.filter((p) => p.role !== "user")).toHaveLength(0);
    } finally {
      await daemon?.close();
      await db.end();
    }
  });

  test("full-prefix resend is idempotent and the lines land", async ({
    authedPage,
  }) => {
    // Registry loss (pod restart) is no longer terminal and there is no session
    // affinity: a full-prefix resend is idempotent (JetStream `Nats-Msg-Id`
    // dedup) and the consume step materializes the run from seq 1. We relay the
    // full prefix TWICE with the gate-minted fence; the second publish dedupes.
    test.setTimeout(CASE_TIMEOUT_MS);
    const { page, user, orgSlug } = authedPage;
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

      const { runId, workItem } = await dispatchAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        "Reply 'ok'.",
      );

      const relayBody = buildRelayBody(
        `msg_lost_e2e_${Date.now()}`,
        "resumed turn lands",
      );

      await relay(runId, workItem.runFenceToken, relayBody);
      await relay(runId, workItem.runFenceToken, relayBody);

      // Parts are written by the async consume step, so poll until the relay's
      // lines land (and the resend was a deduped no-op → run reaches terminal).
      await expect(async () => {
        const parts = await fetchParts(db, runId);
        expect(parts.length).toBeGreaterThan(0);
        expect(await fetchThreadStatus(db, runId)).toBe("completed");
      }).toPass({ timeout: 20_000, intervals: [250, 500, 1000, 2000] });
    } finally {
      await daemon?.close();
      await db.end();
    }
  });
});
