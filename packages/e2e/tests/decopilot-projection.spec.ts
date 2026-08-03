/**
 * E2E: unified projection lifecycle — consume step as sole projector.
 *
 * Since the Task-5/6/11 refactor, `consumeRunProjection` is the ONE place that
 * writes terminal status (completed / failed / requires_action) for ALL run
 * paths (hosted child workflow + desktop/link relay). These tests verify that
 * the refactored path produces the correct outcome at the DB level.
 *
 * ## Coverage
 *
 * 1. **Desktop happy path** — REMOVED. Post-refactor, projection only runs as
 *    the dispatch workflow's per-run consume step, so the desktop happy path
 *    can no longer be driven by a bare seed + NATS publish (nothing would
 *    consume the stream). The dispatch-driven equivalent lives in
 *    `link-ingest.spec.ts` ("matching fence → parts land … run completes"),
 *    which registers a fake desktop daemon, POSTs /messages (starting the
 *    consume step), and relays with the gate-minted fence. That test is the
 *    "consume step is sole projector" regression anchor; duplicating it here as
 *    a bare-seed case would be vacuous, so it was deleted rather than ported.
 *    The entry-guard case that shared this describe block is likewise removed:
 *    a terminal-status short-circuit requires a dispatched-then-terminal run,
 *    which has no e2e-injectable surface (see the unit test for that branch).
 *
 * 2. **Hosted happy path** (LIVE when `E2E_ANTHROPIC_KEY` is set; skipped
 *    otherwise) — POST a user message via `agent-sandbox` and poll until
 *    terminal. The hosted path goes through `hostedHarnessWorkflow → consume
 *    step`, so a terminal row proves consume wrote it.
 *
 * 3. **requires_action** (SKIPPED) — driving a reliable tool-approval pause
 *    from e2e requires either a real model that emits `tool-calls` with a
 *    pending `approval-requested` part, or a harness mock that injects one.
 *    TODO: expose a test hook in `consumeRunProjection` (or a `/__test/...`
 *    endpoint) that accepts a canned relay body carrying a
 *    `{type:"finish-step", finishReason:"tool-calls"}` chunk and an
 *    `approval-requested` part so the status resolver maps it to
 *    `requires_action`.
 *
 * 4. **Parent recovery mid-stream** (SKIPPED) — requires killing the DBOS
 *    worker process mid-flight and asserting that on restart the consume step
 *    re-enters (entry guard passes because status is still `in_progress`),
 *    replays from the durable consumer, and reaches a terminal state without
 *    double-writing parts.
 *    TODO: add a `/__test/decopilot/consume/kill-worker-mid-stream` endpoint
 *    (pause + signal + resume) behind a dedicated multi-pod test gate.
 *
 * 5. **Parent recovery after terminal** (SKIPPED) — requires triggering a
 *    second invocation of `consumeRunProjection` for an already-terminal run
 *    and asserting the entry guard short-circuits (`isTerminalStatus(row.status)`
 *    returns immediately). Without a multi-pod DBOS test harness this cannot be
 *    driven from e2e.
 *    TODO: same multi-pod controls as case 4.
 *
 * 6. **Dead producer / idle-timeout** (SKIPPED) — `consumeRunProjection`
 *    accepts `idleTimeoutMs` but that parameter is only wired at the
 *    call-site inside the hosted workflow, not injectable from a public API
 *    surface. Driving this from e2e would require either:
 *    (a) a `/__test/decopilot/consume/idle-timeout` hook that starts a consume
 *        step with a very short `idleTimeoutMs` and no producer, or
 *    (b) exposing `idleTimeoutMs` via a query param / header on the hosted
 *        dispatch route for test builds.
 *    TODO: implement option (a) in a `dev-only` test-route module and gate it
 *    behind `process.env.NODE_ENV === "test"`.
 *
 * 7. **Idempotent terminal re-delivery** (SKIPPED) — verifying that a
 *    redelivered `{done}` envelope (e.g. if the consume step crashes after
 *    projecting but before ack-ing) does not double-write status or double-count
 *    analytics requires publishing the same `{done}` message twice with the
 *    same `Nats-Msg-Id` header and asserting a single terminal row. The
 *    `publishRelayBodyToNats` helper uses JetStream dedup via `Nats-Msg-Id`
 *    headers; to drive the dedup-bypass case (force-publish after dedup window)
 *    we need a lower-level NATS publish helper not currently available in fixtures.
 *    TODO: add a `publishRelayBodyRaw()` variant to `relay-nats.ts` that bypasses
 *    JetStream dedup so the idempotency path can be exercised directly.
 *
 * ## Relationship to existing specs
 *
 * - `link-ingest.spec.ts` covers the desktop path comprehensively (fence
 *   matching, mismatched fence, full-prefix resend) via real dispatch + relay,
 *   which is now the ONLY way to exercise the consume step. The desktop happy
 *   path + entry-guard cases that used to live here are subsumed by that spec
 *   (see case 1 above); this spec now only carries the hosted-path LIVE case
 *   (gated on E2E_ANTHROPIC_KEY) plus the documented SKIPPED future cases.
 */

import { expect, test } from "../fixtures/test";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";

// ---------------------------------------------------------------------------
// Environment gates
// ---------------------------------------------------------------------------

const ANTHROPIC_AVAILABLE = !!process.env.E2E_ANTHROPIC_KEY;

// ---------------------------------------------------------------------------
// DB helpers (scoped; mirror link-ingest.spec.ts)
// ---------------------------------------------------------------------------

/** Fetch the `threads.status` for a thread. */
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

/** Fetch `thread_message_parts` rows for a given run id, ordered by seq. */
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

// ---------------------------------------------------------------------------
// Test 1: Desktop happy path + entry guard — REMOVED.
//
// Post-refactor projection only runs as the dispatch workflow's per-run consume
// step, so a bare seed + NATS publish no longer projects anything (nothing
// consumes the stream). The dispatch-driven equivalent of the desktop happy
// path lives in `link-ingest.spec.ts` ("matching fence → parts land … run
// completes"); the entry-guard short-circuit has no e2e-injectable surface
// (a dispatched-then-terminal run) and is covered by the consume-step unit
// test. Keeping bare-seed versions here would false-pass, so they were deleted.
// See the header doc's Coverage section.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test 2: Hosted happy path (LIVE when E2E_ANTHROPIC_KEY is set)
// ---------------------------------------------------------------------------

test.describe("decopilot projection — hosted happy path", () => {
  test.skip(
    !ANTHROPIC_AVAILABLE,
    "Requires E2E_ANTHROPIC_KEY — the hosted path spawns a real harness via " +
      "hostedHarnessWorkflow which needs a live Anthropic credential. Without " +
      "it the run would dispatch but the harness would fail to get a model " +
      "response, producing 'failed' instead of 'completed'. " +
      "TODO: expose a fake-harness mode (e.g. DECOPILOT_HARNESS_STUB=1) that " +
      "publishes a canned relay body to JetStream so the hosted path can be " +
      "tested without a real model.",
  );

  test("hosted dispatch reaches completed with assistant parts and title set", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    try {
      // Create agent + thread (both belong to this tenant's org).
      const agent = await callSelfMcpTool<{ item: { id: string } }>(
        api,
        orgSlug,
        "COLLECTION_VIRTUAL_MCP_CREATE",
        {
          data: {
            title: "Projection hosted e2e",
            connections: [],
            status: "active",
            pinned: false,
          },
        },
      );
      const thread = await callSelfMcpTool<{
        item: { id: string; title: string };
      }>(api, orgSlug, "COLLECTION_THREADS_CREATE", {
        data: { virtual_mcp_id: agent.item.id },
      });
      expect(thread.item.title).toBe("New chat");

      // POST the selectorless hosted contract. The persisted thread selects
      // Decopilot + agent-sandbox; hostedHarnessWorkflow then feeds
      // consumeRunProjection as the sole terminal-status writer.
      const runResp = await api.post(
        `/api/${orgSlug}/decopilot/threads/${thread.item.id}/messages`,
        {
          data: {
            messages: [
              {
                role: "user",
                parts: [{ type: "text", text: "Reply with one word: hello" }],
              },
            ],
            branch: "ephemeral",
            temperature: 0,
          },
          headers: { "content-type": "application/json" },
        },
      );
      expect(runResp.status()).toBe(202);
      const { taskId: runId } = (await runResp.json()) as { taskId: string };
      expect(typeof runId).toBe("string");

      // Poll until the consume step commits parts and flips terminal status.
      // Allow 60s: real Anthropic round-trip + harness startup.
      await expect(async () => {
        const parts = await fetchParts(db, runId);
        expect(parts.length).toBeGreaterThanOrEqual(2);
        const kinds = parts.map((p) => p.kind);
        expect(kinds).toContain("text");
        expect(kinds).toContain("finish");
        expect(await fetchThreadStatus(db, runId)).toBe("completed");
      }).toPass({ timeout: 60_000, intervals: [500, 1000, 2000, 3000] });

      // Title should have been set by the title-interceptor inside the consume path.
      const { rows } = await db.query<{ title: string }>(
        `SELECT title FROM threads WHERE id = $1`,
        [thread.item.id],
      );
      const title = rows[0]?.title ?? "New chat";
      expect(title).not.toBe("New chat");
      expect(title.length).toBeGreaterThan(0);
    } finally {
      await db.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: requires_action (SKIPPED)
// ---------------------------------------------------------------------------

test.describe("decopilot projection — requires_action", () => {
  test.skip(
    true,
    "requires_action is produced when resolveThreadStatus maps finishReason=" +
      "'tool-calls' + an `approval-requested` part (or a pending `user_ask`). " +
      "Driving this deterministically from e2e requires " +
      "either a real model that emits tool-calls with a pending approval, or a " +
      "test hook that injects a canned relay body whose finish-step chunk carries " +
      "finishReason='tool-calls' AND a synthesized approval-requested part so the " +
      "status resolver maps it to requires_action. " +
      "TODO: add a /__test/decopilot/consume/requires-action endpoint (dev-only) " +
      "that seeds a run, publishes a crafted relay body, and returns the final " +
      "thread status so the e2e assertion can verify requires_action without " +
      "needing a live model.",
  );

  test("run ending in tool-approval pause reaches requires_action", () => {
    // Placeholder — see skip reason above.
  });
});

// ---------------------------------------------------------------------------
// Test 4: Parent recovery mid-stream (SKIPPED)
// ---------------------------------------------------------------------------

test.describe("decopilot projection — parent recovery mid-stream", () => {
  test.skip(
    true,
    "Requires killing and restarting the DBOS worker mid-stream (while the " +
      "consume step is in its drain loop) and asserting the run recovers to a " +
      "correct terminal state with no duplicate parts. This requires multi-pod " +
      "DBOS test controls not available from a public HTTP surface. " +
      "TODO: implement a /__test/decopilot/consume/kill-mid-stream endpoint " +
      "that orchestrates: start consume step, pause it mid-drain, restart, " +
      "assert single terminal write, behind a dedicated test gate.",
  );

  test("worker crash mid-stream: run still reaches terminal with no duplicate parts", () => {
    // Placeholder — see skip reason above.
  });
});

// ---------------------------------------------------------------------------
// Test 5: Parent recovery after terminal (SKIPPED)
// ---------------------------------------------------------------------------

test.describe("decopilot projection — parent recovery after terminal", () => {
  test.skip(
    true,
    "Requires triggering a second invocation of consumeRunProjection for an " +
      "already-terminal run (e.g. DBOS re-executes the step after a crash between " +
      "the terminal write and the step ack) and asserting the entry guard " +
      "short-circuits immediately (isTerminalStatus returns true) without re-writing " +
      "status or re-projecting parts. Without multi-pod DBOS controls this cannot " +
      "be driven from e2e. See the entry-guard unit test for the same assertion at " +
      "the function level. " +
      "TODO: same multi-pod endpoint as case 4 above, behind a dedicated " +
      "test gate.",
  );

  test("worker crash after terminal: re-entry returns immediately, no double-write", () => {
    // Placeholder — see skip reason above.
  });
});

// ---------------------------------------------------------------------------
// Test 6: Dead producer / idle-timeout (SKIPPED)
// ---------------------------------------------------------------------------

test.describe("decopilot projection — dead producer idle-timeout", () => {
  test.skip(
    true,
    "consumeRunProjection accepts idleTimeoutMs to backstop a producer that " +
      "stalls without emitting {done}. The parameter is only wired inside the " +
      "hosted workflow — there is no public API surface to inject a short " +
      "idleTimeoutMs from e2e. " +
      "TODO: expose idleTimeoutMs via one of: " +
      "(a) a /__test/decopilot/consume/idle-timeout endpoint (dev-only) that " +
      "    starts consume with idleTimeoutMs=500 and no producer, asserts 'failed'; " +
      "(b) an DECOPILOT_CONSUME_IDLE_TIMEOUT_MS env var override for test builds. " +
      "The unit-level test for the idle branch already lives in " +
      "consume-run-projection.test.ts (if it exists); this e2e case validates " +
      "the full DB write path (markRunFailed persists to threads table).",
  );

  test("producer stalls: run reaches failed via idle-timeout", () => {
    // Placeholder — see skip reason above.
  });
});

// ---------------------------------------------------------------------------
// Test 7: Idempotent terminal re-delivery (SKIPPED)
// ---------------------------------------------------------------------------

test.describe("decopilot projection — idempotent terminal re-delivery", () => {
  test.skip(
    true,
    "Verifying that a redelivered {done} envelope (same JetStream message " +
      "delivered twice, e.g. after a crash before ack) does not double-write " +
      "terminal status or double-count analytics requires: " +
      "(a) publishing the same {done} line with the same Nats-Msg-Id header twice " +
      "    (bypassing JetStream dedup), or " +
      "(b) a /__test/... endpoint that invokes runProjectorWorkflowBody twice for " +
      "    the same {done} and asserts a single status-write via an idempotency guard. " +
      "The current publishRelayBody helper uses JetStream dedup (Nats-Msg-Id " +
      "headers), so a second publish of the same body is silently deduplicated by " +
      "the broker rather than reaching the consumer twice. " +
      "TODO: add publishRelayBodyRaw() to relay-nats.ts (bypasses Nats-Msg-Id dedup) " +
      "and add the assertion: after two raw publishes, status is written exactly once " +
      "(check by counting terminal-status transitions in the threads table or by " +
      "asserting analytics events via a test capture hook).",
  );

  test("redelivered {done}: terminal status written exactly once", () => {
    // Placeholder — see skip reason above.
  });
});
