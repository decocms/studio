/**
 * E2E: POST /api/:org/links/runs/:runId/stream — link ingest return path.
 *
 * The desktop daemon runs a harness locally and POSTs the resulting
 * UIMessageChunk SSE stream to this endpoint, which:
 *   1. Checks the run_fence_token (409 on mismatch).
 *   2. Parses the SSE body (parseDispatchSSEStream).
 *   3. Commits parts to thread_message_parts via PartEmitter (consumePartStream).
 *   4. Pumps chunks to the JetStream live edge (StreamBuffer.pump).
 *
 * This spec verifies the happy path (matching fence → 200 + parts land) and
 * the stale-fence path (mismatched token → 409 + zero parts).
 *
 * Wire format: concatenated `data: <json>\n\n` blocks, each containing one
 * `{type:"ui-message-chunk", chunk: UIMessageChunk}` event, followed by a
 * `{type:"done"}` sentinel.
 */

import { expect, test } from "../fixtures/test";
import { connectDevDb } from "../fixtures/db";

// ---------------------------------------------------------------------------
// Helpers
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

/**
 * Seed a minimal v2 thread with a given run_fence_token (null = no fence).
 * Returns the thread/run id (they are the same value today).
 */
async function seedV2Thread(
  db: Awaited<ReturnType<typeof connectDevDb>>,
  {
    orgId,
    userId,
    runFenceToken,
  }: { orgId: string; userId: string; runFenceToken: string | null },
): Promise<string> {
  const threadId = `thrd_ingest_e2e_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO threads
       (id, organization_id, title, status, virtual_mcp_id,
        message_storage_version, run_fence_token, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, 'in_progress', '', 2, $4, $5, $5, $6)`,
    [threadId, orgId, "Link ingest e2e thread", runFenceToken, now, userId],
  );
  return threadId;
}

/**
 * Fetch the thread_message_parts rows for the given run (runId == threadId).
 */
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
 * Build a minimal dispatch SSE body that carries a single assistant turn:
 *   start → start-step → text-start → text-delta → text-end → finish-step → finish
 * followed by a `done` sentinel. The message id is deterministic so callers
 * can assert against it.
 */
function buildSseBody(messageId: string, text: string): string {
  // Exactly the SDK-verified UIMessageChunk sequence the consume-part-stream
  // unit test proved assembles into one text message (ai@6: text deltas use
  // `delta`, text parts key on `id`). Wrapped as `ui-message-chunk` events.
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("POST /api/:org/links/runs/:runId/stream — link ingest", () => {
  test("matching fence token → 200 and parts land in thread_message_parts", async ({
    authedPage,
  }) => {
    const { page, user, orgSlug } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    try {
      const orgId = await orgIdForSlug(db, orgSlug);
      const fenceToken = `fence_${Date.now()}`;

      const runId = await seedV2Thread(db, {
        orgId,
        userId: user.userId,
        runFenceToken: fenceToken,
      });

      const messageId = `msg_ingest_e2e_${Date.now()}`;
      const bodyText = `link-ingest-e2e-marker-${Date.now()}`;
      const sseBody = buildSseBody(messageId, bodyText);

      const res = await api.post(`/api/${orgSlug}/links/runs/${runId}/stream`, {
        headers: {
          "content-type": "text/event-stream",
          "x-fence-token": fenceToken,
        },
        data: sseBody,
      });

      expect(res.status()).toBe(200);
      const json = await res.json();
      expect(json).toMatchObject({ ok: true });

      // Parts must be committed: at least a text part and a finish anchor.
      const parts = await fetchParts(db, runId);
      expect(parts.length).toBeGreaterThanOrEqual(2);
      const kinds = parts.map((p) => p.kind);
      expect(kinds).toContain("text");
      expect(kinds).toContain("finish");
    } finally {
      await db.end();
    }
  });

  test("stale fence token → 409 and zero parts land", async ({
    authedPage,
  }) => {
    const { page, user, orgSlug } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    try {
      const orgId = await orgIdForSlug(db, orgSlug);
      const realToken = `fence_real_${Date.now()}`;
      const staleToken = `fence_stale_${Date.now()}`;

      const runId = await seedV2Thread(db, {
        orgId,
        userId: user.userId,
        runFenceToken: realToken,
      });

      const messageId = `msg_stale_e2e_${Date.now()}`;
      const sseBody = buildSseBody(messageId, "should not land");

      const res = await api.post(`/api/${orgSlug}/links/runs/${runId}/stream`, {
        headers: {
          "content-type": "text/event-stream",
          "x-fence-token": staleToken,
        },
        data: sseBody,
      });

      expect(res.status()).toBe(409);
      const json = await res.json();
      expect(json).toMatchObject({ error: "fenced" });

      // No parts should have been written.
      const parts = await fetchParts(db, runId);
      expect(parts).toHaveLength(0);
    } finally {
      await db.end();
    }
  });

  test("null fence (no active run) → 409 'no active run fence' and zero parts land", async ({
    authedPage,
  }) => {
    // Asserts the INERT posture: when run_fence_token is null the endpoint
    // must refuse to write anything, regardless of the presented token.
    const { page, user, orgSlug } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    try {
      const orgId = await orgIdForSlug(db, orgSlug);

      // Seed a thread with NO fence token — simulates a thread that exists
      // but for which no run has been started (the fence is never minted in
      // this phase).
      const runId = await seedV2Thread(db, {
        orgId,
        userId: user.userId,
        runFenceToken: null,
      });

      const messageId = `msg_nofence_e2e_${Date.now()}`;
      const sseBody = buildSseBody(messageId, "should not land");

      const res = await api.post(`/api/${orgSlug}/links/runs/${runId}/stream`, {
        headers: {
          "content-type": "text/event-stream",
          // Present any token — must still be rejected because current === null.
          "x-fence-token": `any_token_${Date.now()}`,
        },
        data: sseBody,
      });

      expect(res.status()).toBe(409);
      const json = await res.json();
      expect(json).toMatchObject({ error: "no active run fence" });

      // No parts should have been written.
      const parts = await fetchParts(db, runId);
      expect(parts).toHaveLength(0);
    } finally {
      await db.end();
    }
  });
});
