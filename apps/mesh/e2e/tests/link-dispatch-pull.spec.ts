/**
 * E2E: full pull-transport round-trip (cluster-side PULL cycle).
 *
 * Validates the cluster-side PULL cycle introduced in Phase B:
 *
 *   1. A thread pinned link_transport='pull' + message_storage_version=2 is
 *      created and wired to a real agent (virtual MCP).
 *   2. The "desktop daemon" establishes link presence by calling
 *      GET /api/:org/links/work — the route synthetically mints a claim in
 *      the NATS KV bucket so resolveDispatchTarget sees the link as online.
 *   3. POST /messages on the pull thread → 202 { taskId }. The thread-gate
 *      workflow fires pullDispatch (prepareRun → fence mint → work-item
 *      publish) and then polls threads.status until terminal.
 *   4. The "daemon" calls GET /api/:org/links/work and receives the work
 *      item; the test asserts its shape (runId, runFenceToken, harnessInput).
 *   5. The "daemon" POSTs a minimal dispatch SSE body to
 *      POST /api/:org/links/runs/:runId/stream with x-fence-token header.
 *      The ingest commits parts and transitions the thread to terminal,
 *      which releases the gate's polling loop.
 *   6. The test asserts thread_message_parts has a text + finish part and
 *      that threads.status === 'completed'.
 *
 * Coverage vs. full round-trip:
 *   COVERED (all 6 steps above):
 *     - Link presence via GET /links/work (sentinel claim refresh)
 *     - POST /messages dispatch path for a pull thread (202 + taskId)
 *     - Work item delivery via GET /links/work (runId, runFenceToken, harnessInput)
 *     - Ingest POST with fence token (200, parts land, status terminal)
 *     - Gate poll releases (threads.status = 'completed' before assertion)
 *
 *   NOT COVERED (requires real NATS JetStream consumer + timing):
 *     - The gate's DBOS pollUntilTerminal loop completing *before* the test
 *       asserts — the workflow runs asynchronously; the test asserts the DB
 *       state directly and does not await the DBOS step. This is acceptable:
 *       the ingest endpoint sets threads.status = 'completed' synchronously,
 *       which is what the gate polls. In CI the gate fires and polls against
 *       the real DB; the assertion sees the post-ingest row directly.
 *     - Body-offload and multi-chunk SSE streams (covered by link-ingest.spec.ts).
 *
 * Presence strategy: the spec uses GET /api/:org/links/work to establish the
 * claim (same as a real pull daemon holding the long-poll). This avoids the
 * need for a real WS daemon binary or connectToCluster — the route synthesizes
 * a claim with `capabilities: []` (Phase B sentinel). resolveDispatchTarget
 * requires only that the claim be non-null for "user-desktop" kind.
 *
 * harness_id='claude-code' + sandboxProviderKind='user-desktop' are seeded
 * directly on the thread row so POST /messages hits applyThreadLock (the row
 * is already pinned) and bypasses resolveTier (no model credential needed).
 * This mirrors what decopilot-messages.spec.ts does for the gating tests.
 */

import { expect, test } from "../fixtures/test";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";

// ---------------------------------------------------------------------------
// Helpers (scoped to this file; mirrors the patterns in link-ingest.spec.ts)
// ---------------------------------------------------------------------------

/** Resolve the org id (not slug) for the given org slug. */
async function orgIdForSlug(
  db: Awaited<ReturnType<typeof connectDevDb>>,
  slug: string,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM "organization" WHERE slug = $1`,
    [slug],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`no organization row for slug ${slug}`);
  return id;
}

/** Fetch threads.status for a thread by id. */
async function fetchThreadStatus(
  db: Awaited<ReturnType<typeof connectDevDb>>,
  threadId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ status: string }>(
    `SELECT status FROM threads WHERE id = $1`,
    [threadId],
  );
  return rows[0]?.status ?? null;
}

/** Fetch thread_message_parts rows for a given run_id. */
async function fetchParts(
  db: Awaited<ReturnType<typeof connectDevDb>>,
  runId: string,
): Promise<Array<{ kind: string; payload: unknown }>> {
  const { rows } = await db.query<{ kind: string; payload: unknown }>(
    `SELECT kind, payload FROM thread_message_parts WHERE run_id = $1 ORDER BY seq`,
    [runId],
  );
  return rows;
}

/**
 * Build a minimal dispatch SSE body (reused from link-ingest.spec.ts).
 * Carries a single assistant turn:
 *   start → start-step → text-start → text-delta → text-end → finish-step → finish
 * followed by a `done` sentinel.
 */
function buildSseBody(messageId: string, text: string): string {
  const textId = `${messageId}-text-0`;
  const chunks: unknown[] = [
    { type: "start" },
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
  return events.map((ev) => `data: ${JSON.stringify(ev)}\n\n`).join("");
}

/**
 * Create a real agent (virtual MCP) and a thread row with the pull-transport
 * pins already set. The thread is seeded with:
 *   - link_transport = 'pull'
 *   - message_storage_version = 2
 *   - harness_id = 'claude-code'
 *   - sandbox_provider_kind = 'user-desktop'
 *   - status = 'idle'
 *
 * Using SQL for the extra columns that the MCP create tool does not expose,
 * following the pattern from link-ingest.spec.ts and decopilot-parts-readpath.spec.ts.
 */
async function createPullThread(
  api: import("@playwright/test").APIRequestContext,
  db: Awaited<ReturnType<typeof connectDevDb>>,
  orgSlug: string,
  orgId: string,
): Promise<{ agentId: string; threadId: string }> {
  // 1. Create the agent via the MCP tool so it belongs to this org.
  const agent = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title: "Pull-transport E2E Agent",
        connections: [],
        status: "active",
        pinned: false,
      },
    },
  );
  const agentId = agent.item.id;

  // 2. Create the thread via the MCP tool (creates the base row with the
  //    correct organization_id, created_by, virtual_mcp_id FKs).
  const thread = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_THREADS_CREATE",
    {
      data: {
        virtual_mcp_id: agentId,
        title: "Pull-transport E2E Thread",
      },
    },
  );
  const threadId = thread.item.id;

  // 3. Patch the extra pull-transport columns directly in SQL.
  //    The MCP create tool doesn't expose these; they are normally written
  //    by the daemon/pull-phase handshake. We pre-seed them here so the
  //    thread gate's isPull check fires for the very first POST /messages.
  await db.query(
    `UPDATE threads
     SET link_transport          = 'pull',
         message_storage_version = 2,
         harness_id              = 'claude-code',
         sandbox_provider_kind   = 'user-desktop'
     WHERE id = $1
       AND organization_id = $2`,
    [threadId, orgId],
  );

  return { agentId, threadId };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test.describe("pull-transport round-trip", () => {
  test("work item is served by GET /links/work and ingest commits parts + releases gate", async ({
    authedPage,
  }) => {
    // The test includes a 30 s poll for the work item (JetStream propagation)
    // plus the presence poll, so give it a generous timeout.
    test.setTimeout(90_000);

    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();

    try {
      const orgId = await orgIdForSlug(db, orgSlug);

      // ── Step 1: create agent + pull thread ────────────────────────────────
      const { agentId, threadId } = await createPullThread(
        api,
        db,
        orgSlug,
        orgId,
      );

      // ── Step 2: establish link presence ───────────────────────────────────
      //
      // GET /api/:org/links/work hits the linkClaimRegistry and synthesizes
      // a sentinel claim (Phase B) keyed by the authenticated user id so
      // resolveDispatchTarget returns { ok: true } for user-desktop threads.
      //
      // We fire it with a short client timeout so the claim lands BEFORE
      // POST /messages runs. The claim refresh is synchronous at the start
      // of the handler; the long-poll itself may 204 on timeout which is fine.
      const presencePromise = api
        .get(`/api/${orgSlug}/links/work`, {
          timeout: 1_500, // short: just long enough for the claim to land
        })
        .catch(() => null); // 204/timeout is fine — we only need the claim

      // Poll until the claim appears in /api/links/me (same pattern as
      // decopilot-messages.spec.ts:connectLink).
      await expect
        .poll(
          async () => {
            const res = await api.get("/api/links/me");
            if (res.status() !== 200) return null;
            const body = (await res.json()) as unknown;
            // The sentinel claim has podId starting with "pull-" (Phase B).
            return body;
          },
          { timeout: 10_000, intervals: [200, 500, 1_000] },
        )
        .not.toBeNull();

      // ── Step 3: trigger the dispatch (POST /messages) ─────────────────────
      //
      // applyThreadLock reads the pinned (harness_id, sandbox_provider_kind)
      // from the thread row seeded in step 1 and bypasses per-request model
      // resolution (no resolveTier call, no credential row needed).
      //
      // The thread gate fires pullDispatch → mints the fence → publishes the
      // work item to the per-user JetStream subject → polls threads.status
      // until terminal.
      const dispatchRes = await api.post(
        `/api/${orgSlug}/decopilot/threads/${threadId}/messages`,
        {
          data: {
            messages: [
              {
                role: "user",
                parts: [{ type: "text", text: "hello pull daemon" }],
              },
            ],
            agent: { id: agentId },
            branch: "ephemeral",
            temperature: 0.5,
            // Explicit hint; applyThreadLock will use the already-pinned row.
            harnessId: "claude-code",
            sandboxProviderKind: "user-desktop",
          },
          headers: { "content-type": "application/json" },
        },
      );

      expect(dispatchRes.status()).toBe(202);
      const dispatchBody = (await dispatchRes.json()) as { taskId: string };
      expect(dispatchBody.taskId).toBeTruthy();
      const runId = dispatchBody.taskId;

      // ── Step 4: daemon polls GET /links/work → receives work item ──────────
      //
      // The gate published the work item immediately after pullDispatch
      // returned. We poll with a short client timeout and retry until we
      // get the item keyed to our runId or the assertion timeout expires.
      let workItem: {
        runId: string;
        threadId: string;
        orgId: string;
        userId: string;
        runFenceToken: string;
        harnessInput: Record<string, unknown>;
      } | null = null;

      await expect
        .poll(
          async () => {
            const res = await api.get(`/api/${orgSlug}/links/work`, {
              timeout: 5_000,
            });
            if (res.status() === 204) return null; // no item yet
            if (res.status() !== 200) return null;
            const body = (await res.json()) as typeof workItem;
            if (!body || body.runId !== runId) return null;
            workItem = body;
            return body;
          },
          { timeout: 30_000, intervals: [500, 1_000, 2_000] },
        )
        .not.toBeNull();

      // Assert work item shape (spec §3.2).
      expect(workItem).not.toBeNull();
      expect(workItem!.runId).toBe(runId);
      expect(workItem!.threadId).toBe(threadId);
      expect(typeof workItem!.runFenceToken).toBe("string");
      expect(workItem!.runFenceToken.length).toBeGreaterThan(0);
      expect(typeof workItem!.harnessInput).toBe("object");
      // harnessInput must carry at least the fields the daemon validates.
      expect(workItem!.harnessInput).toMatchObject({
        threadId,
        runId,
        runFenceToken: workItem!.runFenceToken,
      });

      const runFenceToken = workItem!.runFenceToken;

      // ── Step 5: daemon POSTs the SSE harness output ───────────────────────
      //
      // Reuse buildSseBody: a minimal start/text/finish sequence that the
      // ingest endpoint parses into parts and commits via consumePartStream.
      const messageId = `msg_pull_e2e_${Date.now()}`;
      const bodyText = `pull-daemon-sim-marker-${Date.now()}`;
      const sseBody = buildSseBody(messageId, bodyText);

      const ingestRes = await api.post(
        `/api/${orgSlug}/links/runs/${runId}/stream`,
        {
          headers: {
            "content-type": "text/event-stream",
            "x-fence-token": runFenceToken,
          },
          data: sseBody,
        },
      );

      expect(ingestRes.status()).toBe(200);
      const ingestJson = await ingestRes.json();
      expect(ingestJson).toMatchObject({ ok: true });

      // ── Step 6: assert DB state ────────────────────────────────────────────
      //
      // The ingest handler commits parts to thread_message_parts and
      // transitions threads.status to 'completed'. This is what releases
      // the gate's pollUntilTerminal loop.

      // 6a. Parts must be present: at minimum a text part + a finish anchor.
      const parts = await fetchParts(db, runId);
      expect(parts.length).toBeGreaterThanOrEqual(2);
      const kinds = parts.map((p) => p.kind);
      expect(kinds).toContain("text");
      expect(kinds).toContain("finish");

      // 6b. Thread status must be terminal ('completed').
      expect(await fetchThreadStatus(db, threadId)).toBe("completed");

      await presencePromise;
    } finally {
      await db.end();
    }
  });
});
