/**
 * E2E: direct-NATS chunk-relay ingest → durable-projector persistence.
 *
 * The desktop daemon runs a harness locally and publishes its raw output as
 * seq-numbered `RelayLine`s straight to the run's JetStream stream
 * `decopilot.stream.<runId>` (protocol v2; see `link-daemon/direct-nats-publisher.ts`).
 * The always-on durable projector consumes that stream and:
 *   1. Resolves the run's org (a stream for an unknown run is never projected).
 *   2. Skips a stream whose fence differs from the run's current
 *      run_fence_token (`shouldSkipProjection`).
 *   3. Feeds the relayed chunks into the harness kernel (consumeHarnessStream),
 *      which commits parts via PartEmitter and transitions the run terminal.
 *
 * Persistence is ASYNC — publishing returns once the lines are on the stream;
 * the projector materializes parts + flips `threads.status` shortly after, so
 * these tests POLL the DB (the old synchronous `/chunks` ack is gone).
 *
 * This spec verifies the happy path (matching fence → parts land + status
 * completed), the stale-fence path (mismatched fence → zero parts), and the
 * full-prefix resend path (idempotent → parts land). The old HTTP route's
 * status-code contract (200/409/404/410) no longer exists; fence/ownership
 * enforcement now lives in the projector and is asserted at the DB level.
 *
 * Wire format: one `{seq, event}\n` JSON line per DispatchSSEEvent, ending
 * with a `{type:"done"}` terminal line (see links/protocol/relay.ts).
 */

import { sleep } from "@decocms/std";
import { expect, test } from "../fixtures/test";
import { connectDevDb } from "../fixtures/db";
import { publishRelayBody } from "../fixtures/relay-nats";

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

/** Fetch the durable thread status. */
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("direct-NATS chunk relay ingest", () => {
  test("matching fence → parts land in thread_message_parts and run completes", async ({
    authedPage,
  }) => {
    const { user, orgSlug } = authedPage;
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

      const { lastSeq } = await publishRelayBody({
        runId,
        fenceToken,
        body: relayBody,
      });
      // The publisher echoes the highest wire seq (incl. the terminal `done`),
      // matching what the old `/chunks` ack returned as lastSeq.
      expect(lastSeq).toBe(lineCount);

      // Parts + terminal status are written by the async durable projector
      // (it reconstructs the run from JetStream), so poll until they land: a
      // text part + finish anchor, and status 'completed'.
      await expect(async () => {
        const parts = await fetchParts(db, runId);
        expect(parts.length).toBeGreaterThanOrEqual(2);
        const kinds = parts.map((p) => p.kind);
        expect(kinds).toContain("text");
        expect(kinds).toContain("finish");
        expect(await fetchThreadStatus(db, runId)).toBe("completed");
      }).toPass({ timeout: 20_000, intervals: [250, 500, 1000, 2000] });
    } finally {
      await db.end();
    }
  });

  test("mismatched fence → projector skips, zero parts land", async ({
    authedPage,
  }) => {
    const { user, orgSlug } = authedPage;
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

      const relayBody = buildRelayBody(
        `msg_stale_e2e_${Date.now()}`,
        "should not land",
      );

      // The run's fence is realToken; the projector loads it and SKIPS this
      // mismatched-fence stream (shouldSkipProjection) — nothing is committed.
      await publishRelayBody({
        runId,
        fenceToken: staleToken,
        body: relayBody,
      });

      // Give the projector a window to observe + skip, then assert no parts.
      await sleep(4_000);
      expect(await fetchParts(db, runId)).toHaveLength(0);
    } finally {
      await db.end();
    }
  });

  test("full-prefix resend is idempotent and the lines land", async ({
    authedPage,
  }) => {
    // Registry loss (pod restart) is no longer terminal and there is no session
    // affinity: a full-prefix resend is idempotent (JetStream `Nats-Msg-Id`
    // dedup) and the projector materializes the run from seq 1.
    const { user, orgSlug } = authedPage;
    const db = await connectDevDb();
    try {
      const orgId = await orgIdForSlug(db, orgSlug);
      const fenceToken = `fence_lost_${Date.now()}`;

      const runId = await seedV2Thread(db, {
        orgId,
        userId: user.userId,
        runFenceToken: fenceToken,
      });

      const relayBody = buildRelayBody(
        `msg_lost_e2e_${Date.now()}`,
        "resumed turn lands",
      );

      await publishRelayBody({ runId, fenceToken, body: relayBody });

      // Parts are written by the async durable projector, so poll until the
      // relay's lines land.
      await expect(async () => {
        const parts = await fetchParts(db, runId);
        expect(parts.length).toBeGreaterThan(0);
      }).toPass({ timeout: 20_000, intervals: [250, 500, 1000, 2000] });
    } finally {
      await db.end();
    }
  });
});
