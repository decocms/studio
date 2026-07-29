/**
 * E2E: unified-control-plane proof suite (T9).
 *
 * Two proofs from `docs/superpowers/specs/2026-07-09-unified-control-plane-design.md`
 * that need a real dispatched run (not a bare-seed/unit test):
 *
 *   1. **Hosted setup-failure surfaces as a stream event.** T1 made the
 *      hosted child a pure executor: it catches ALL its own failures and
 *      publishes an in-band `{type:"error"}` chunk + `{done}` to the run's
 *      subject, carrying the REAL `err.message` (never a masked generic).
 *      This test proves that end-to-end through a real POST → gate v4 →
 *      hostedHarnessWorkflow → consumeRunProjection round trip.
 *
 *   2. **Executor death mid-run → liveness terminal.** T4 replaced the old
 *      unbounded/30-min idle heuristic with a first-class liveness rule:
 *      the consume step's live subject tail goes silent for
 *      `RUN_IDLE_TIMEOUT_MS` ⇒ the projector synthesizes a `failed` terminal
 *      with `failure_kind: "liveness"`. This test proves that with a real
 *      desktop-topology dispatch whose fake daemon publishes a few chunks
 *      then never publishes again (no `{done}`) — the black-box equivalent
 *      of the daemon process dying mid-stream: the consume step only ever
 *      observes the JetStream subject, never the daemon's process liveness
 *      directly, so "publishes then goes silent" and "daemon crashed" are
 *      indistinguishable from the studio's point of view.
 *
 * ## Environment facts this suite depends on
 *
 * - **e2e orgs have NO AI provider by default.** POSTing a hosted
 *   (`sandboxProviderKind: "agent-sandbox"`) message with no tier resolution
 *   path 400s with `TierUnavailableError` at POST time — before the gate
 *   ever dispatches (see `resolvePerRequestModels` → `resolveTier` in
 *   `apps/api/src/api/routes/decopilot/routes.ts`). The workaround (same
 *   one the thread-message-queue project used, and the one
 *   `tests/multi-pod/lib/setup.ts`'s `wireMockProvider` uses for the
 *   multi-pod cluster): create a real `ai_provider_keys` row via
 *   `AI_PROVIDER_KEY_CREATE` and pin it to the "smart" tier via
 *   `ORGANIZATION_SETTINGS_UPDATE` BEFORE posting. `resolveTier`'s fast path
 *   (`slot && keys.some(k => k.id === slot.keyId)`) then resolves
 *   successfully WITHOUT ever calling the provider — the credential only
 *   needs to exist, not work. POST returns 202, the gate dispatches, and the
 *   hosted child only discovers the endpoint is unusable when it actually
 *   tries to stream a completion — exactly the "unusable provider config
 *   that throws in the child post-start" scenario the brief asks for.
 *
 * - **`RUN_IDLE_TIMEOUT_MS` is env-shortened for this webServer.**
 *   `packages/e2e/playwright.config.ts` sets it to 120s (production default:
 *   10 minutes) specifically so proof 2 doesn't block CI for 10 real
 *   minutes. See `run-registry.ts`'s doc comment on the override.
 */

import { expect, test } from "../fixtures/test";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import {
  createTunnelLinkDaemon,
  type TunnelLinkDaemon,
} from "../fixtures/links-presence";
import { publishRelayManual } from "../fixtures/relay-nats";
import { DEFAULT_THREAD_TITLE } from "@decocms/harness/decopilot/prompt-constants";
import type { APIRequestContext } from "@playwright/test";

type Db = Awaited<ReturnType<typeof connectDevDb>>;

async function orgIdForSlug(db: Db, slug: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM "organization" WHERE slug = $1`,
    [slug],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`no organization row for slug ${slug}`);
  return id;
}

async function fetchThreadRow(
  db: Db,
  threadId: string,
): Promise<{
  status: string | null;
  failureReason: string | null;
  failureKind: string | null;
}> {
  const { rows } = await db.query<{
    status: string;
    failure_reason: string | null;
    failure_kind: string | null;
  }>(`SELECT status, failure_reason, failure_kind FROM threads WHERE id = $1`, [
    threadId,
  ]);
  return {
    status: rows[0]?.status ?? null,
    failureReason: rows[0]?.failure_reason ?? null,
    failureKind: rows[0]?.failure_kind ?? null,
  };
}

async function fetchErrorPartTexts(
  db: Db,
  threadId: string,
): Promise<string[]> {
  const { rows } = await db.query<{ payload: unknown }>(
    `SELECT payload FROM thread_message_parts WHERE thread_id = $1 AND kind = 'error' ORDER BY seq`,
    [threadId],
  );
  return rows.map((r) => {
    const payload = r.payload as { text?: unknown } | null;
    return typeof payload?.text === "string" ? payload.text : "";
  });
}

// ---------------------------------------------------------------------------
// Proof 1: hosted setup-failure surfaces as a stream event
// ---------------------------------------------------------------------------

test.describe("decopilot hosted — setup-failure surfaces as a stream event", () => {
  test("an unreachable provider endpoint fails the hosted run with the REAL error text, not a masked generic — no hang", async ({
    authedPage,
  }) => {
    test.setTimeout(90_000);
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    try {
      const orgId = await orgIdForSlug(db, orgSlug);

      // ── Dummy provider key: exists (so resolveTier's fast path resolves
      // without ever calling the provider) but points at a closed local
      // port, so the FIRST real model call the hosted child makes fails
      // fast and deterministically with a genuine network error — no
      // external network dependency, no flakiness.
      const key = await callSelfMcpTool<{ id: string }>(
        api,
        orgSlug,
        "AI_PROVIDER_KEY_CREATE",
        {
          providerId: "openai-compatible",
          label: `e2e-unreachable-${Date.now()}`,
          apiKey: JSON.stringify({
            baseUrl: "http://127.0.0.1:1/v1",
            apiKey: "unused",
          }),
        },
      );
      await callSelfMcpTool(api, orgSlug, "ORGANIZATION_SETTINGS_UPDATE", {
        organizationId: orgId,
        simple_mode: {
          tiers: {
            fast: null,
            smart: { keyId: key.id, modelId: "mock-model" },
            thinking: null,
            image: null,
            web_search: null,
            deep_research: null,
          },
        },
      });

      const agent = await callSelfMcpTool<{ item: { id: string } }>(
        api,
        orgSlug,
        "COLLECTION_VIRTUAL_MCP_CREATE",
        {
          data: {
            title: "Hosted setup-failure e2e agent",
            connections: [],
            status: "active",
            pinned: false,
          },
        },
      );
      const thread = await callSelfMcpTool<{ item: { id: string } }>(
        api,
        orgSlug,
        "COLLECTION_THREADS_CREATE",
        { data: { virtual_mcp_id: agent.item.id } },
      );
      const threadId = thread.item.id;

      // ── The load-bearing assertion at POST time: the dummy key makes the
      // tier check pass (202), NOT the 400 TierUnavailableError an e2e org
      // gets by default. If this regresses to 400, the rest of the test is
      // vacuous (the gate never dispatches) — so pin it explicitly.
      const runResp = await api.post(
        `/api/${orgSlug}/decopilot/threads/${threadId}/messages`,
        {
          data: {
            messages: [
              { role: "user", parts: [{ type: "text", text: "hello" }] },
            ],
            agent: { id: agent.item.id },
            branch: "ephemeral",
            temperature: 0,
            sandboxProviderKind: "agent-sandbox",
            harnessId: "decopilot",
          },
          headers: { "content-type": "application/json" },
        },
      );
      expect(runResp.status()).toBe(202);
      const { taskId: runId } = (await runResp.json()) as { taskId: string };
      expect(typeof runId).toBe("string");

      // ── The contract: the thread reaches `failed` — not a hang, not a
      // 10-minute-later reaper force-fail — because the hosted child's own
      // catch (T1) publishes a fenced error terminal the instant the model
      // call fails, and the projector (live-tailing, T3) folds it
      // immediately. Bounded well under RUN_IDLE_TIMEOUT_MS.
      await expect(async () => {
        const row = await fetchThreadRow(db, threadId);
        expect(row.status).toBe("failed");
      }).toPass({ timeout: 60_000, intervals: [500, 1000, 2000, 5000] });

      const row = await fetchThreadRow(db, threadId);
      // Not the liveness path — this must resolve fast, well inside the
      // idle window, via the harness's own error-catch.
      expect(row.failureKind).not.toBe("liveness");

      // ── THE REAL-REASON ASSERTION: the persisted error part carries the
      // genuine underlying failure (a connection error against
      // 127.0.0.1:1), never a masked placeholder like "An error occurred".
      const errorTexts = await fetchErrorPartTexts(db, threadId);
      expect(errorTexts.length).toBeGreaterThan(0);
      const combined = errorTexts.join(" ");
      expect(combined).not.toBe("");
      expect(combined).not.toContain("An error occurred");
      expect(combined.toLowerCase()).toContain("connect");
    } finally {
      await db.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Proof 2: executor death mid-run → liveness terminal
// ---------------------------------------------------------------------------

/**
 * Create an agent (virtual MCP) + a v2 thread pinned to a user-desktop /
 * claude-code target, mirroring `decopilot-fence-queueing.spec.ts` /
 * `decopilot-thread-queue.spec.ts`'s helper of the same name (each spec
 * owns its own copy by existing repo convention — see those files' Task 9
 * DRY notes for why this isn't factored into a shared fixture).
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
        title: "Liveness e2e agent",
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

function postMessage(
  api: APIRequestContext,
  orgSlug: string,
  agentId: string,
  threadId: string,
  messageText: string,
) {
  return api.post(`/api/${orgSlug}/decopilot/threads/${threadId}/messages`, {
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
  });
}

test.describe("decopilot desktop — executor death mid-run reaches a liveness terminal", () => {
  test("a daemon that publishes a few chunks then goes silent (never {done}) fails the thread with a liveness reason, bounded by the shortened RUN_IDLE_TIMEOUT_MS", async ({
    authedPage,
  }) => {
    // Bounded above the shortened RUN_IDLE_TIMEOUT_MS (120s, see
    // playwright.config.ts) with headroom for the poll's own interval +
    // dispatch/claim round trip.
    test.setTimeout(200_000);
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

      const dispatchRes = await postMessage(
        api,
        orgSlug,
        agentId,
        threadId,
        "Executor will die after a couple of chunks.",
      );
      expect(dispatchRes.status()).toBe(202);
      const { taskId: runId } = (await dispatchRes.json()) as {
        taskId: string;
      };
      expect(runId).toBeTruthy();

      const workItem = await daemon.nextWorkItem(runId);
      expect(workItem.runId).toBe(runId);
      expect(workItem.threadId).toBe(threadId);
      expect(typeof workItem.runFenceToken).toBe("string");

      // ── Publish a FEW chunks (proves the run genuinely started and was
      // making progress), then go silent forever — no `{done}`, no error
      // event, nothing. The consume step only ever watches the JetStream
      // subject, not the daemon's process itself, so this is the faithful
      // black-box equivalent of "the desktop daemon process dies mid-run":
      // from the studio's point of view the two are indistinguishable —
      // both are "no more events on the subject."
      const assistantMessageId = `msg_liveness_${Date.now()}`;
      const textId = `${assistantMessageId}-text-0`;
      await publishRelayManual({
        runId: workItem.runId,
        fenceToken: workItem.runFenceToken,
        chunks: [
          { seq: 1, chunk: { type: "start", messageId: assistantMessageId } },
          { seq: 2, chunk: { type: "start-step" } },
          { seq: 3, chunk: { type: "text-start", id: textId } },
          {
            seq: 4,
            chunk: {
              type: "text-delta",
              id: textId,
              delta: "partial reply before the executor dies",
            },
          },
        ],
        // No doneFinalSeq — the daemon goes silent right here.
      });

      // ── The contract: the thread eventually reaches `failed` with
      // `failure_kind: "liveness"` and a `failure_reason` mentioning
      // "liveness" — not stuck `in_progress` forever, not the old opaque
      // "projection" reason. The poll window comfortably exceeds the
      // shortened RUN_IDLE_TIMEOUT_MS (120s) so this is observing the real
      // liveness enforcement, not a lucky early poll.
      await expect(async () => {
        const row = await fetchThreadRow(db, threadId);
        expect(row.status).toBe("failed");
        expect(row.failureKind).toBe("liveness");
        expect(row.failureReason ?? "").toContain("liveness");
      }).toPass({ timeout: 170_000, intervals: [2_000, 5_000, 10_000] });

      // The liveness terminal is the ONLY signal. The projector's own stream
      // error must never land in the thread as the assistant saying "Error:
      // producer produced no output before timeout" — that string is a
      // projector implementation detail, not a reply.
      expect(await fetchErrorPartTexts(db, threadId)).toEqual([]);
    } finally {
      await daemon?.close();
      await db.end();
    }
  });
});
