/**
 * E2E: durable cancel flag.
 *
 * The old control long-poll route AND the HTTP chunk-ingest backstop (which
 * 409'd a relay once `cancel_requested_at` was set) were both removed with the
 * pull transport. Cancellation now propagates to the desktop daemon over the
 * control channel, which stops the harness at the source. What remains as a
 * cluster-side contract is that the cancel route durably records the request —
 * this spec asserts that flag is persisted.
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
  test("cancel sets the durable cancel flag", async ({ authedPage }) => {
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

      // Verify the durable cancel flag is set in the DB. (The old cluster-side
      // ingest backstop that 409'd a relay after this flag was set is gone —
      // the projector does not consult cancel_requested_at; cancellation is
      // enforced at the daemon via the control channel.)
      const { rows } = await db.query<{ cancel_requested_at: string | null }>(
        `SELECT cancel_requested_at FROM threads WHERE id = $1`,
        [threadId],
      );
      expect(rows[0]?.cancel_requested_at).not.toBeNull();
    } finally {
      await db.end();
    }
  });
});
