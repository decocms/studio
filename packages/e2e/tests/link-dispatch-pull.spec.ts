/**
 * E2E: full tunnel-link round-trip.
 *
 * Validates the cluster-side desktop link cycle:
 *
 *   1. A thread pinned to a user-desktop runtime (harness_id='claude-code',
 *      sandbox_provider_kind='user-desktop') + message_storage_version=2 is
 *      created and wired to a real agent (virtual MCP). The S6 gate routes it
 *      to pull because the resolved dispatch target is
 *      `sandboxProviderKind:'user-desktop'`.
 *   2. The "desktop daemon" establishes link presence by writing the NATS KV
 *      claim and serving the user's tunnel hostname.
 *   3. POST /messages on the pull thread → 202 { taskId }. The thread-gate
 *      workflow fires pullDispatch (prepareRun → fence mint → work-item
 *      publish) and then polls threads.status until terminal.
 *   4. The "daemon" receives the tunneled POST /api/links/work
 *      item; the test asserts its shape (runId, runFenceToken, harnessInput).
 *   5. The "daemon" publishes a seq-numbered NDJSON chunk relay (protocol v2)
 *      straight to the run's JetStream stream `decopilot.stream.<runId>` with
 *      the run fence token. The always-on durable projector consumes the
 *      relayed chunks, commits parts, and transitions the thread to terminal,
 *      which releases the gate's polling loop.
 *   6. The test polls thread_message_parts for a text + finish part and
 *      that threads.status === 'completed'.
 *
 * Coverage vs. full round-trip:
 *   COVERED (all 6 steps above):
 *     - Link presence via the tunnel claim
 *     - POST /messages dispatch path for a pull thread (202 + taskId)
 *     - Work item delivery over `@decocms/tunnel` (runId, runFenceToken, harnessInput)
 *     - Chunk relay published to JetStream with the fence token (parts land,
 *       status terminal)
 *     - Gate poll releases (threads.status = 'completed' before assertion)
 *
 *   NOT COVERED (requires real NATS JetStream consumer + timing):
 *     - The gate's DBOS pollUntilTerminal loop completing *before* the test
 *       asserts — the workflow runs asynchronously; the test asserts the DB
 *       state directly and does not await the DBOS step. This is acceptable:
 *       the chunks endpoint sets threads.status = 'completed' before acking
 *       the terminal POST, which is what the gate polls. In CI the gate fires
 *       and polls against the real DB; the assertion sees the post-relay row
 *       directly.
 *     - Reconnect/backfill (full-prefix resend) and body-offload (covered by
 *       link-ingest.spec.ts and the chunk-relay unit tests).
 *
 * Presence strategy: the spec writes the same NATS KV claim produced by the
 * production CLI and starts a tunnel server for the user's hostname.
 *
 * harness_id='claude-code' + sandboxProviderKind='user-desktop' are seeded
 * directly on the thread row so POST /messages hits applyThreadLock (the row
 * is already pinned) and bypasses resolveTier (no model credential needed).
 * This mirrors what decopilot-messages.spec.ts does for the gating tests.
 */

import { expect, test } from "../fixtures/test";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import {
  createTunnelLinkDaemon,
  type TunnelLinkDaemon,
} from "../fixtures/links-presence";
import { publishRelayBody } from "../fixtures/relay-nats";

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
 * Build a minimal NDJSON chunk-relay body (protocol v2; mirrors what the real
 * daemon's chunk relay produces — see link-daemon/chunk-relay.ts). Carries a
 * single assistant turn:
 *   start → start-step → text-start → text-delta → text-end → finish-step → finish
 * followed by a terminal `done` line, each wrapped as a seq-numbered
 * `{seq, event}` RelayLine.
 */
function buildRelayBody(messageId: string, text: string): string {
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
  return `${events
    .map((event, i) => JSON.stringify({ seq: i + 1, event }))
    .join("\n")}\n`;
}

/**
 * Create a real agent (virtual MCP) and a thread row with the user-desktop
 * pins already set. The thread is seeded with:
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
  //
  //    Phase C-bis S6: the gate keys on the resolved dispatch target
  //    (`target.sandboxProviderKind === 'user-desktop'`), NOT on `link_transport`. The
  //    target is produced by the presence claim (claude-code) + the pinned
  //    sandbox_provider_kind='user-desktop'/harness_id='claude-code' below, so
  //    `link_transport` is no longer seeded. `message_storage_version = 2`
  //    stays — the gate's v2 conjunct still requires it.
  await db.query(
    `UPDATE threads
     SET message_storage_version = 2,
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
  test("work item carries one Claude Code userMessage with image file parts", async ({
    authedPage,
  }) => {
    test.setTimeout(120_000);

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

      const imageDataUrl =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
      const dispatchRes = await api.post(
        `/api/${orgSlug}/decopilot/threads/${threadId}/messages`,
        {
          data: {
            messages: [
              {
                role: "user",
                parts: [
                  { type: "text", text: "Describe this image briefly." },
                  {
                    type: "file",
                    mediaType: "image/png",
                    filename: "fixture.png",
                    url: imageDataUrl,
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

      expect(dispatchRes.status()).toBe(202);
      const { taskId: runId } = (await dispatchRes.json()) as {
        taskId: string;
      };
      const workItem = await daemon.nextWorkItem(runId);

      expect(workItem.harnessInput).not.toHaveProperty("messages");
      const userMessage = workItem.harnessInput.userMessage as {
        role?: string;
        parts?: Array<Record<string, unknown>>;
      };
      expect(userMessage.role).toBe("user");
      expect(Array.isArray(userMessage.parts)).toBe(true);
      const imagePart = userMessage.parts?.find(
        (part) => part.type === "file" && part.mediaType === "image/png",
      );
      expect(imagePart).toBeTruthy();
      expect(typeof imagePart?.url).toBe("string");
      expect((imagePart?.url as string).length).toBeGreaterThan(0);

      const messageId = `msg_pull_image_e2e_${Date.now()}`;
      const relayBody = buildRelayBody(messageId, "image received");
      await publishRelayBody({
        runId,
        fenceToken: workItem.runFenceToken,
        body: relayBody,
      });

      await expect(async () => {
        expect(await fetchThreadStatus(db, threadId)).toBe("completed");
      }).toPass({ timeout: 20_000, intervals: [250, 500, 1000, 2000] });
    } finally {
      await daemon?.close();
      await db.end();
    }
  });

  test("work item is served over tunnel and ingest commits parts + releases gate", async ({
    authedPage,
  }) => {
    // Budget: up to 3 × 35 s long-poll retries (~105 s) + setup/ingest/assertions.
    // Playwright's per-request default is 30 s, so we override below; the test
    // overall needs at least 120 s.
    test.setTimeout(120_000);

    const { page, orgSlug, user } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    let daemon: TunnelLinkDaemon | null = null;

    try {
      daemon = await createTunnelLinkDaemon(api, user.userId, ["claude-code"]);
      const orgId = await orgIdForSlug(db, orgSlug);

      // ── Step 1: create agent + pull thread ────────────────────────────────
      const { agentId, threadId } = await createPullThread(
        api,
        db,
        orgSlug,
        orgId,
      );

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

      // ── Step 4: tunnel daemon receives the work item ──────────────────────
      const workItem = await daemon.nextWorkItem(runId);

      // Assert work item shape (spec §3.2).
      expect(workItem.runId).toBe(runId);
      expect(workItem.threadId).toBe(threadId);
      expect(typeof workItem.runFenceToken).toBe("string");
      expect(workItem.runFenceToken.length).toBeGreaterThan(0);
      expect(typeof workItem.harnessInput).toBe("object");
      // harnessInput must carry at least the fields the daemon validates.
      expect(workItem.harnessInput).toMatchObject({
        threadId,
        runFenceToken: workItem.runFenceToken,
      });

      const runFenceToken = workItem.runFenceToken;

      // ── Step 5: daemon relays the harness output as NDJSON chunk lines ────
      //
      // Reuse buildRelayBody: a minimal start/text/finish turn + a terminal
      // done line, exactly what the real daemon chunk relay streams. The
      // daemon publishes those lines straight to the run's JetStream stream
      // (`decopilot.stream.<runId>`); the always-on durable projector consumes
      // them and commits parts.
      const messageId = `msg_pull_e2e_${Date.now()}`;
      const bodyText = `pull-daemon-sim-marker-${Date.now()}`;
      const relayBody = buildRelayBody(messageId, bodyText);
      const relayLineCount = relayBody.trim().split("\n").length;

      const { lastSeq } = await publishRelayBody({
        runId,
        fenceToken: runFenceToken,
        body: relayBody,
      });
      // The publisher echoes the highest wire seq (incl. the terminal `done`),
      // matching what the old `/chunks` ack returned.
      expect(lastSeq).toBe(relayLineCount);

      // ── Step 6: assert DB state ────────────────────────────────────────────
      //
      // The projector commits parts to thread_message_parts and transitions
      // threads.status to 'completed' once it consumes the relayed stream. This
      // is what releases the gate's pollUntilTerminal loop.

      // 6a/6b. Parts + terminal status are written by the async durable
      // projector (it reconstructs the run from JetStream after the relay
      // POST returns), so poll until they land: a text part + finish anchor,
      // and status 'completed' — which is what releases the gate.
      await expect(async () => {
        const parts = await fetchParts(db, runId);
        expect(parts.length).toBeGreaterThanOrEqual(2);
        const kinds = parts.map((p) => p.kind);
        expect(kinds).toContain("text");
        expect(kinds).toContain("finish");
        expect(await fetchThreadStatus(db, threadId)).toBe("completed");
      }).toPass({ timeout: 20_000, intervals: [250, 500, 1000, 2000] });
    } finally {
      await daemon?.close();
      await db.end();
    }
  });
});
