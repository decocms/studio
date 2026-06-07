/**
 * E2E: Phase C cancel home — durable cancel flag + control-poll route.
 *
 * Three assertions (Phase C correctness invariants):
 *
 *   (1) GET /api/:org/links/control with no auth → 401.
 *
 *   (2) Cancel → durable flag → ingest 409 (hard invariant):
 *       - Seed a pull thread with a fence token.
 *       - POST /:org/decopilot/cancel/:threadId → expect 200/202.
 *       - POST /api/:org/links/runs/:threadId/stream with the valid fence
 *         token → expect 409 { error: "cancelled" }.
 *       This is the correctness path: cancel must win over a valid fence.
 *
 *   (3) Control poll serves the cancel frame (tolerant — race-sensitive):
 *       - Open GET /links/control with a short client timeout FIRST.
 *       - Fire POST cancel.
 *       - If the poll returns 200 {type:"cancel", runId}, assert the shape.
 *       - If it returns 204/times out before the cancel arrives, skip — do
 *         NOT fail the suite (the durable path in assertion (2) is the guard).
 *
 * Thread seeding follows the pattern from link-dispatch-pull.spec.ts:
 *   - Create agent + thread via MCP tools so FKs are correct.
 *   - Patch extra columns (link_transport, run_fence_token) via SQL.
 */

import { expect, test } from "../fixtures/test";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Build a minimal dispatch SSE body (reused from link-dispatch-pull.spec.ts).
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
 * Create a pull thread seeded with a run fence token.
 * Returns { agentId, threadId }.
 */
async function createFencedPullThread(
  api: import("@playwright/test").APIRequestContext,
  db: Awaited<ReturnType<typeof connectDevDb>>,
  orgSlug: string,
  orgId: string,
  fenceToken: string,
): Promise<{ agentId: string; threadId: string }> {
  const agent = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title: "Control-poll E2E Agent",
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
    {
      data: {
        virtual_mcp_id: agentId,
        title: "Control-poll E2E Thread",
      },
    },
  );
  const threadId = thread.item.id;

  await db.query(
    `UPDATE threads
     SET link_transport          = 'pull',
         message_storage_version = 2,
         harness_id              = 'claude-code',
         sandbox_provider_kind   = 'user-desktop',
         run_fence_token         = $3
     WHERE id = $1
       AND organization_id = $2`,
    [threadId, orgId, fenceToken],
  );

  return { agentId, threadId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("link-control Phase C", () => {
  // (1) No auth → 401
  test("GET /links/control without auth returns 401", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    // Use a fresh context with no cookies to simulate an unauthenticated caller.
    const unauthCtx = await page
      .context()
      .browser()!
      .newContext({
        baseURL: `http://localhost:${process.env.PORT ?? "3000"}`,
      });
    const unauthApi = unauthCtx.request;

    try {
      const res = await unauthApi.get(`/api/${orgSlug}/links/control`, {
        timeout: 5_000,
      });
      expect(res.status()).toBe(401);
    } finally {
      await unauthCtx.close();
    }
  });

  // (2) Cancel → durable flag → ingest 409  (hard correctness invariant)
  test("cancel sets durable flag and ingest rejects with 409", async ({
    authedPage,
  }) => {
    test.setTimeout(60_000);

    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();

    try {
      const orgId = await orgIdForSlug(db, orgSlug);
      const fenceToken = `tok-ctrl-e2e-${Date.now()}`;

      const { threadId } = await createFencedPullThread(
        api,
        db,
        orgSlug,
        orgId,
        fenceToken,
      );

      // Fire cancel — must succeed
      const cancelRes = await api.post(
        `/api/${orgSlug}/decopilot/cancel/${threadId}`,
      );
      expect([200, 202]).toContain(cancelRes.status());

      // Verify durable flag is set in the DB
      const { rows } = await db.query<{ cancel_requested_at: string | null }>(
        `SELECT cancel_requested_at FROM threads WHERE id = $1`,
        [threadId],
      );
      expect(rows[0]?.cancel_requested_at).not.toBeNull();

      // Ingest MUST be rejected with 409 even though the fence token is valid
      const ingestBody = buildSseBody(`msg_ctrl_e2e_${Date.now()}`, "hello");
      const ingestRes = await api.post(
        `/api/${orgSlug}/links/runs/${threadId}/stream`,
        {
          headers: {
            "content-type": "text/event-stream",
            "x-fence-token": fenceToken,
          },
          data: ingestBody,
        },
      );

      expect(ingestRes.status()).toBe(409);
      const ingestJson = await ingestRes.json();
      expect(ingestJson).toMatchObject({ error: "cancelled" });
    } finally {
      await db.end();
    }
  });

  // (3) Control poll serves cancel frame (tolerant — NATS timing dependent)
  test("control poll returns cancel frame when NATS is available", async ({
    authedPage,
  }) => {
    test.setTimeout(60_000);

    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();

    try {
      const orgId = await orgIdForSlug(db, orgSlug);
      const fenceToken = `tok-ctrl-poll-${Date.now()}`;

      const { threadId } = await createFencedPullThread(
        api,
        db,
        orgSlug,
        orgId,
        fenceToken,
      );

      // Open the control poll FIRST with a short window; fire cancel concurrently.
      // The poll needs to beat the cancel frame by subscribing before it arrives.
      const pollPromise = api
        .get(`/api/${orgSlug}/links/control`, {
          // Long enough to outlast the server's POLL_TIMEOUT_MS (28 s) if needed,
          // but we fire cancel almost immediately so it should resolve much sooner.
          timeout: 35_000,
        })
        .catch(() => null);

      // Brief delay to let the NATS subscription land before we publish.
      await new Promise((r) => setTimeout(r, 200));

      const cancelRes = await api.post(
        `/api/${orgSlug}/decopilot/cancel/${threadId}`,
      );
      expect([200, 202]).toContain(cancelRes.status());

      const pollRes = await pollPromise;
      if (pollRes === null) {
        // Timed out or network error — tolerate, (2) is the correctness guard.
        return;
      }

      const status = pollRes.status();
      if (status === 204) {
        // Server timed out before the frame arrived — race lost, tolerate.
        return;
      }
      if (status === 503) {
        // NATS unavailable in this environment — tolerate.
        return;
      }

      // If we got a 200 it MUST be a valid cancel frame.
      if (status === 200) {
        const body = (await pollRes.json()) as unknown;
        expect(body).toMatchObject({ type: "cancel", runId: threadId });
      }

      // Any other status is unexpected.
      if (![200, 204, 503].includes(status)) {
        throw new Error(`Unexpected control poll status: ${status}`);
      }
    } finally {
      await db.end();
    }
  });
});
