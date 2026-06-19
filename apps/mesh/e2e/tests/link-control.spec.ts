/**
 * E2E: durable cancel flag.
 *
 * The old control long-poll route was removed with the pull transport. The
 * correctness invariant that remains at the HTTP layer is: cancel wins over a
 * valid run fence, and chunk ingest rejects with 409.
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
 * Build a minimal NDJSON chunk-relay body (reused from
 * link-dispatch-pull.spec.ts — seq-numbered RelayLines, protocol v2).
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
      const ingestBody = buildRelayBody(`msg_ctrl_e2e_${Date.now()}`, "hello");
      const ingestRes = await api.post(
        `/api/${orgSlug}/links/runs/${threadId}/chunks`,
        {
          headers: {
            "content-type": "application/x-ndjson",
            "x-fence-token": fenceToken,
            "x-relay-from": "1",
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
});
