/**
 * E2E: POST /api/:org/links/runs/:runId/chunks — link chunk-relay return path.
 *
 * The desktop daemon runs a harness locally and relays its raw output as
 * seq-numbered NDJSON `RelayLine`s to this endpoint (protocol v2), which:
 *   1. Enforces org-scoped thread ownership (404 for foreign/missing runs).
 *   2. Checks the durable cancel flag, then the run_fence_token (409s).
 *   3. Feeds the relayed chunks into the harness kernel
 *      (consumeHarnessStream), which commits parts via PartEmitter.
 *   4. Pumps kernel output to the JetStream live edge and transitions the
 *      run terminal before acking the terminal POST with {ok, lastSeq}.
 *
 * This spec verifies the happy path (matching fence → 200 + parts land +
 * status completed), the stale-fence path (409 + zero parts), the no-fence
 * path (409 + zero parts), and the lost-session resume path (410).
 *
 * Wire format: one `{seq, event}\n` JSON line per DispatchSSEEvent, ending
 * with a `{type:"done"}` terminal line (see links/protocol/relay.ts).
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

/** Fetch the durable thread status (terminal transition before terminal ack). */
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

/**
 * Build a minimal NDJSON chunk-relay body carrying a single assistant turn:
 *   start → start-step → text-start → text-delta → text-end → finish-step → finish
 * followed by a terminal `done` line. Each line is a seq-numbered RelayLine,
 * exactly what the real daemon chunk relay streams (link-daemon/chunk-relay.ts).
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

function relayHeaders(fenceToken: string, fromSeq = 1): Record<string, string> {
  return {
    "content-type": "application/x-ndjson",
    "x-fence-token": fenceToken,
    "x-relay-from": String(fromSeq),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("POST /api/:org/links/runs/:runId/chunks — chunk relay ingest", () => {
  test("matching fence token → 200 {ok,lastSeq} and parts land in thread_message_parts", async ({
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
      const relayBody = buildRelayBody(messageId, bodyText);
      const lineCount = relayBody.trim().split("\n").length;

      const res = await api.post(`/api/${orgSlug}/links/runs/${runId}/chunks`, {
        headers: relayHeaders(fenceToken),
        data: relayBody,
      });

      expect(res.status()).toBe(200);
      const json = await res.json();
      expect(json).toMatchObject({ ok: true, lastSeq: lineCount });

      // Parts must be committed: at least a text part and a finish anchor.
      const parts = await fetchParts(db, runId);
      expect(parts.length).toBeGreaterThanOrEqual(2);
      const kinds = parts.map((p) => p.kind);
      expect(kinds).toContain("text");
      expect(kinds).toContain("finish");

      // The terminal POST is acked only after the run transitioned terminal
      // (durably), which is what releases the pull gate's threads.status poll.
      expect(await fetchThreadStatus(db, runId)).toBe("completed");
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
      const relayBody = buildRelayBody(messageId, "should not land");

      const res = await api.post(`/api/${orgSlug}/links/runs/${runId}/chunks`, {
        headers: relayHeaders(staleToken),
        data: relayBody,
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
    // When run_fence_token is null there is no active pull run for the
    // thread, so the endpoint must refuse to write anything regardless of
    // the presented token.
    const { page, user, orgSlug } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    try {
      const orgId = await orgIdForSlug(db, orgSlug);

      const runId = await seedV2Thread(db, {
        orgId,
        userId: user.userId,
        runFenceToken: null,
      });

      const messageId = `msg_nofence_e2e_${Date.now()}`;
      const relayBody = buildRelayBody(messageId, "should not land");

      const res = await api.post(`/api/${orgSlug}/links/runs/${runId}/chunks`, {
        headers: relayHeaders(`any_token_${Date.now()}`),
        data: relayBody,
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

  test("resumed relay with no parked session (x-relay-from > 1) opens fresh (no 410; idempotent resend)", async ({
    authedPage,
  }) => {
    // Registry loss (pod restart) is no longer terminal: a full-prefix resend
    // is idempotent (§10, the cluster dedupes by seq), so a resumed relay with
    // no parked session opens a FRESH session and accepts the lines rather than
    // 410-ing the daemon into giving up.
    const { page, user, orgSlug } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    try {
      const orgId = await orgIdForSlug(db, orgSlug);
      const fenceToken = `fence_lost_${Date.now()}`;

      const runId = await seedV2Thread(db, {
        orgId,
        userId: user.userId,
        runFenceToken: fenceToken,
      });

      const messageId = `msg_lost_e2e_${Date.now()}`;
      const relayBody = buildRelayBody(messageId, "resumed turn lands");

      const res = await api.post(`/api/${orgSlug}/links/runs/${runId}/chunks`, {
        headers: relayHeaders(fenceToken, 5),
        data: relayBody,
      });

      expect(res.status()).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });

      // The fresh session processed the relayed turn → parts persist.
      const parts = await fetchParts(db, runId);
      expect(parts.length).toBeGreaterThan(0);
    } finally {
      await db.end();
    }
  });
});
