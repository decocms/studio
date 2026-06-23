/**
 * E2E: harness conformance suite — ONE behavior case list, run against the
 * harness kernel through the chunk-relay return path.
 *
 * ## What "conformance" means here
 *
 * After Transport Convergence the cluster has a SINGLE consume-side stream
 * layer: `consumeHarnessStream` (the harness kernel), driven by the durable
 * projector. BOTH the hosted path (`dispatch-run.ts` → in-process harness
 * chunks → JetStream) and the pull-relay path (daemon publishes chunks straight
 * to `decopilot.stream.<runId>`) feed the SAME projector/kernel. So title
 * gating, usage → metadata + PostHog, part persistence, run-status transitions,
 * and the claude-code session round-trip are kernel behaviors that MUST hold
 * identically no matter where the chunks originate. This suite encodes those
 * behaviors as a case list and drives them through the relay path — the one
 * path fully drivable headless in e2e.
 *
 * ## Drivers
 *
 * - **relay driver (RUNNABLE):** the tunnel link pattern. Seed a v2
 *   thread pinned to a user-desktop/claude-code target, claim link presence,
 *   POST /messages (→ 202 + the gate publishes a work item over NATS), receive
 *   that work item through `@decocms/tunnel`, then publish a CANNED NDJSON chunk
 *   relay straight to the run's JetStream stream with the run fence token (the
 *   `relay()` helper, mirroring `direct-nats-publisher`). The durable projector
 *   consumes the relayed chunks and commits all durable effects ASYNCHRONOUSLY,
 *   so assertions POLL the DB + the v2 read-path tool
 *   (`COLLECTION_THREAD_MESSAGES_LIST`).
 *
 * - **hosted driver (NOT headless-runnable — see `test.skip` block at the
 *   bottom):** triggering a hosted decopilot turn end-to-end requires a REAL
 *   model credential. `harnessId: "decopilot"` forces per-request model
 *   resolution via `resolveTier`, which 400s on an org with no model configured
 *   (documented in decopilot-messages.spec.ts), and even a CLI harness
 *   (claude-code) on `agent-sandbox` needs a real sandbox/LLM to emit chunks.
 *   There is no mock-AI provider wired into the e2e harness. Rather than fake a
 *   pass, the hosted driver is skipped with a precise TODO. NOTE the kernel it
 *   would exercise is the SAME `consumeHarnessStream` the relay driver already
 *   drives end-to-end here, so these behaviors ARE covered for the shared layer;
 *   the skip only leaves the hosted CHUNK SOURCE (in-process harness) unverified
 *   by this suite (it is covered by the harness unit tests + the cluster e2e
 *   that drives the gating path in decopilot-messages.spec.ts).
 *
 * ## Faithful fixtures
 *
 * Canned chunk sequences come from `fixtures/relay-chunks.ts`, which emits the
 * real per-turn order (start → start-step → text-start/delta/end → finish-step
 * → finish) with `finish.messageMetadata` carrying usage +
 * codingAgentSessionId, exactly as `harnesses/cli-stream-metadata.ts` builds it.
 */

import { expect, test } from "../fixtures/test";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import {
  createTunnelLinkDaemon,
  type TunnelLinkDaemon,
} from "../fixtures/links-presence";
import {
  buildErrorRelayBody,
  buildTurnRelayBody,
} from "../fixtures/relay-chunks";
import { publishRelayBody } from "../fixtures/relay-nats";
import { sleep } from "@decocms/std";
// The auto-titler gates on the thread title being this exact default; import
// the source constant so the gating cases stay in lockstep if it ever changes.
import { DEFAULT_THREAD_TITLE } from "@decocms/harness/decopilot/prompt-constants";
import type { APIRequestContext } from "@playwright/test";

// ---------------------------------------------------------------------------
// Shared helpers (mirror link-dispatch-pull.spec.ts / link-ingest.spec.ts)
// ---------------------------------------------------------------------------

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

async function fetchThreadStatus(
  db: Db,
  threadId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ status: string }>(
    `SELECT status FROM threads WHERE id = $1`,
    [threadId],
  );
  return rows[0]?.status ?? null;
}

async function fetchThreadTitle(db: Db, threadId: string): Promise<string> {
  const { rows } = await db.query<{ title: string }>(
    `SELECT title FROM threads WHERE id = $1`,
    [threadId],
  );
  return rows[0]?.title ?? "";
}

async function fetchParts(
  db: Db,
  runId: string,
): Promise<
  Array<{ kind: string; role: string; payload: unknown; metadata: unknown }>
> {
  const { rows } = await db.query<{
    kind: string;
    role: string;
    payload: unknown;
    metadata: unknown;
  }>(
    `SELECT kind, role, payload, metadata FROM thread_message_parts WHERE run_id = $1 ORDER BY seq`,
    [runId],
  );
  return rows;
}

/** Count distinct part-row ids for a run (dedupe assertions). */
async function fetchPartRowIdCount(db: Db, runId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM thread_message_parts WHERE run_id = $1`,
    [runId],
  );
  return Number(rows[0]?.n ?? "0");
}

/**
 * Create an agent (virtual MCP) + a v2 thread pinned to a user-desktop /
 * claude-code target so POST /messages routes to the pull gate (Phase C-bis
 * S6) without per-request model resolution. Optionally seed a non-default
 * title (for the "renamed thread is not re-titled" case).
 */
async function createPullThread(
  api: APIRequestContext,
  db: Db,
  orgSlug: string,
  orgId: string,
  opts: { title?: string } = {},
): Promise<{ agentId: string; threadId: string }> {
  const agent = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title: "Harness-conformance E2E Agent",
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
        // The titler gates on this being the default; cases that need a
        // default-title thread pass `undefined` and we force it below.
        title: opts.title ?? "Harness-conformance E2E Thread",
      },
    },
  );
  const threadId = thread.item.id;

  // Pin the pull-transport columns + set the requested title. The titler
  // compares against the REQUEST-time thread title, which the dispatch route
  // reads off this row, so seeding it here controls the gating behavior.
  await db.query(
    `UPDATE threads
     SET message_storage_version = 2,
         harness_id              = 'claude-code',
         sandbox_provider_kind   = 'user-desktop',
         title                   = $3
     WHERE id = $1
       AND organization_id = $2`,
    [threadId, orgId, opts.title ?? DEFAULT_THREAD_TITLE],
  );

  return { agentId, threadId };
}

interface WorkItem {
  runId: string;
  threadId: string;
  orgId: string;
  userId: string;
  runFenceToken: string;
  harnessInput: Record<string, unknown>;
  messagesRef?: { url: string; bytes: number; sha256: string };
}

/**
 * Trigger a dispatch by POSTing a user message, then wait for the tunnel daemon
 * to receive the matching work item. Returns the runId + the work item (whose
 * runFenceToken the relay POST presents). `messageText` may be large (offload
 * case).
 */
async function dispatchAndClaimWorkItem(
  api: APIRequestContext,
  orgSlug: string,
  agentId: string,
  threadId: string,
  daemon: TunnelLinkDaemon,
  messageText: string,
): Promise<{ runId: string; workItem: WorkItem }> {
  const dispatchRes = await api.post(
    `/api/${orgSlug}/decopilot/threads/${threadId}/messages`,
    {
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
    },
  );
  expect(dispatchRes.status()).toBe(202);
  const { taskId: runId } = (await dispatchRes.json()) as { taskId: string };
  expect(runId).toBeTruthy();

  const workItem = await daemon.nextWorkItem(runId);
  expect(workItem.runId).toBe(runId);
  expect(workItem.threadId).toBe(threadId);
  expect(typeof workItem.runFenceToken).toBe("string");
  expect(workItem.runFenceToken.length).toBeGreaterThan(0);

  return { runId, workItem };
}

/**
 * Relay a canned NDJSON chunk body as the fake daemon: publish each line
 * straight to the run's JetStream stream (`decopilot.stream.<runId>`), exactly
 * as the desktop daemon now does — the old POST /chunks ingest route is gone.
 *
 * Returns the publisher's `lastSeq` (highest wire seq incl. the terminal
 * `done`), the same value the old `/chunks` ack reported. Persistence is async:
 * the always-on durable projector materializes parts + flips status shortly
 * after, so callers must POLL the DB for durable effects.
 */
function relay(runId: string, fenceToken: string, body: string) {
  return publishRelayBody({ runId, fenceToken, body });
}

/** Read back the folded messages via the real v2 read-path tool. */
async function listMessages(
  api: APIRequestContext,
  orgSlug: string,
  threadId: string,
): Promise<
  Array<{ id: string; role: string; parts: unknown[]; metadata: unknown }>
> {
  const result = await callSelfMcpTool<{
    items: Array<{
      id: string;
      role: string;
      parts: unknown[];
      metadata: unknown;
    }>;
    totalCount: number;
  }>(api, orgSlug, "COLLECTION_THREAD_MESSAGES_LIST", { thread_id: threadId });
  return result.items;
}

// Per-test budget: up to 3 × 35 s long-poll retries + setup + relay + reads.
const CASE_TIMEOUT_MS = 130_000;

// ---------------------------------------------------------------------------
// Case list — relay driver (the runnable conformance corpus).
//
// Each case is a real `test(...)`: full setup → dispatch → claim work item →
// POST canned relay → assert the shared kernel's durable effects.
// ---------------------------------------------------------------------------

test.describe("harness conformance — relay driver", () => {
  test("persists assistant message parts (read back via the v2 read path)", async ({
    authedPage,
  }) => {
    test.setTimeout(CASE_TIMEOUT_MS);
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
      const { runId, workItem } = await dispatchAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        "say hello",
      );

      const messageId = `msg_conf_parts_${Date.now()}`;
      const text = `conformance-parts-marker-${Date.now()}`;
      const { body, lineCount } = buildTurnRelayBody({ messageId, text });
      const { lastSeq } = await relay(runId, workItem.runFenceToken, body);
      expect(lastSeq).toBe(lineCount);

      // Persistence is async (durable DBOS projector). Poll the DB + read path
      // until the projection lands.
      await expect(async () => {
        // DB: a text part + a finish anchor landed for the run.
        const parts = await fetchParts(db, runId);
        const kinds = parts.map((p) => p.kind);
        expect(kinds).toContain("text");
        expect(kinds).toContain("finish");

        // Read path: the folded assistant message carries the relayed text.
        const items = await listMessages(api, orgSlug, threadId);
        const assistant = items.find((m) => m.role === "assistant");
        expect(assistant, "assistant message folded back").toBeTruthy();
        expect(JSON.stringify(assistant!.parts)).toContain(text);
      }).toPass({ timeout: 20_000, intervals: [250, 500, 1000, 2000] });
    } finally {
      await daemon?.close();
      await db.end();
    }
  });

  test("relay persists the assistant message + flips status, ordered after the user message, never empty", async ({
    authedPage,
  }) => {
    // The regression bundle: the relay path must, once projected, leave the
    // assistant message present, the status terminal, the parts ordered
    // (user before assistant — the "out of order" bug), and the assistant
    // bubble non-empty (a content-less finish must not fold to a blank bubble).
    //
    // NOTE: with the direct-NATS projector, persistence is ASYNC — the daemon
    // publishes to JetStream and the durable projector commits parts + flips
    // status shortly after (the synchronous relay-side write was removed with
    // the /chunks route). So these effects are asserted as eventually-consistent
    // (polled), not the instant the relay returns.
    test.setTimeout(CASE_TIMEOUT_MS);
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
      const { runId, workItem } = await dispatchAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        "say hello",
      );

      const messageId = `msg_sync_${Date.now()}`;
      const text = `sync-persist-marker-${Date.now()}`;
      const { body, lineCount } = buildTurnRelayBody({ messageId, text });
      const { lastSeq } = await relay(runId, workItem.runFenceToken, body);
      expect(lastSeq).toBe(lineCount);

      // The durable projector persists the assistant message + flips status
      // asynchronously — poll until ALL the regression-bundle effects hold.
      await expect(async () => {
        // 1. The assistant message persisted: a text part + a finish anchor.
        const parts = await fetchParts(db, runId);
        const assistantKinds = parts
          .filter((p) => p.role === "assistant")
          .map((p) => p.kind);
        expect(assistantKinds).toContain("text");
        expect(assistantKinds).toContain("finish");

        // 2. The run status flipped to completed — the "status too late" bug.
        expect(await fetchThreadStatus(db, runId)).toBe("completed");

        // 3. Ordering: the user message's parts sort strictly before the
        //    assistant's — the "out of order" bug. Assert at the DB level
        //    (created_at), independent of any read-path cache.
        const ordered = await db.query<{ role: string; created_at: string }>(
          `SELECT role, MIN(created_at) AS created_at FROM thread_message_parts
             WHERE run_id = $1 GROUP BY role ORDER BY created_at`,
          [runId],
        );
        const roleOrder = ordered.rows.map((r) => r.role);
        expect(roleOrder).toEqual(["user", "assistant"]);

        // 4. Never empty: the folded assistant message has a renderable part
        //    carrying the relayed text (no blank bubble).
        const items = await listMessages(api, orgSlug, threadId);
        const userIdx = items.findIndex((m) => m.role === "user");
        const assistantIdx = items.findIndex((m) => m.role === "assistant");
        expect(userIdx).toBeGreaterThanOrEqual(0);
        expect(assistantIdx).toBeGreaterThan(userIdx);
        const assistant = items[assistantIdx]!;
        expect(assistant.parts.length).toBeGreaterThan(0);
        expect(JSON.stringify(assistant.parts)).toContain(text);
      }).toPass({ timeout: 20_000, intervals: [250, 500, 1000, 2000] });
    } finally {
      await daemon?.close();
      await db.end();
    }
  });

  test("auto-title persists exactly once AND only when the thread title is default", async ({
    authedPage,
  }) => {
    test.setTimeout(CASE_TIMEOUT_MS);
    const { page, orgSlug, user } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    let daemon: TunnelLinkDaemon | null = null;
    try {
      daemon = await createTunnelLinkDaemon(api, user.userId, ["claude-code"]);
      const orgId = await orgIdForSlug(db, orgSlug);

      // Case A: default-title thread → the relayed title is persisted.
      {
        const { agentId, threadId } = await createPullThread(
          api,
          db,
          orgSlug,
          orgId,
          // default title (forced to DEFAULT_THREAD_TITLE in createPullThread)
        );
        expect(await fetchThreadTitle(db, threadId)).toBe(DEFAULT_THREAD_TITLE);
        const { runId, workItem } = await dispatchAndClaimWorkItem(
          api,
          orgSlug,
          agentId,
          threadId,
          daemon,
          "what is the weather",
        );
        const newTitle = `Conformance Auto Title ${Date.now()}`;
        const { body } = buildTurnRelayBody({
          messageId: `msg_conf_title_${Date.now()}`,
          text: "the weather is fine",
          title: newTitle,
        });
        await relay(runId, workItem.runFenceToken, body);
        // Auto-title persistence is async (durable projector). The projector is
        // idempotent (writes the title exactly once), so the value becomes
        // stable once projected — poll until it lands.
        await expect(async () => {
          expect(await fetchThreadTitle(db, threadId)).toBe(newTitle);
        }).toPass({ timeout: 20_000, intervals: [250, 500, 1000, 2000] });
      }

      // Case B: a RENAMED thread → the relayed title is NOT applied.
      {
        const userTitle = `User Renamed ${Date.now()}`;
        const { agentId, threadId } = await createPullThread(
          api,
          db,
          orgSlug,
          orgId,
          { title: userTitle },
        );
        expect(await fetchThreadTitle(db, threadId)).toBe(userTitle);
        const { runId, workItem } = await dispatchAndClaimWorkItem(
          api,
          orgSlug,
          agentId,
          threadId,
          daemon,
          "another question",
        );
        const { body } = buildTurnRelayBody({
          messageId: `msg_conf_notitle_${Date.now()}`,
          text: "an answer",
          title: `Should Not Apply ${Date.now()}`,
        });
        await relay(runId, workItem.runFenceToken, body);
        // Title interceptor gates on the thread's CURRENT DB title (read at
        // relay time) != default, so the user's title survives. (Here that
        // equals the title set at thread creation — nothing renames between
        // dispatch and relay.) Persistence is async (durable projector); poll
        // until the run has projected (assistant message present) and confirm
        // the user's title was NOT overwritten.
        await expect(async () => {
          const items = await listMessages(api, orgSlug, threadId);
          expect(
            items.find((m) => m.role === "assistant"),
            "assistant message projected",
          ).toBeTruthy();
          expect(await fetchThreadTitle(db, threadId)).toBe(userTitle);
        }).toPass({ timeout: 20_000, intervals: [250, 500, 1000, 2000] });
      }
    } finally {
      await daemon?.close();
      await db.end();
    }
  });

  test("final message metadata carries usage (lands on the persisted finish anchor)", async ({
    authedPage,
  }) => {
    // PostHog isn't observable in e2e (no capture sink exposed to the test), so
    // we assert the closest observable: the usage the kernel's onUsage hook
    // reads is the SAME usage folded onto the persisted assistant message
    // metadata (finish-anchor row). The PostHog `chat_message_completed` fire
    // is unit-covered (consume-harness-stream.test.ts / link-ingest tests).
    test.setTimeout(CASE_TIMEOUT_MS);
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
      const { runId, workItem } = await dispatchAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        "count my tokens",
      );

      const usage = { inputTokens: 11, outputTokens: 22, totalTokens: 33 };
      const { body } = buildTurnRelayBody({
        messageId: `msg_conf_usage_${Date.now()}`,
        text: "tokens counted",
        usage,
      });
      await relay(runId, workItem.runFenceToken, body);

      // Persistence is async (durable projector). Poll the DB + read path until
      // the usage-bearing finish anchor projects.
      await expect(async () => {
        // The finish anchor row's metadata carries the usage block. NB: a v2
        // pull thread persists TWO finish anchors — the user message's (at
        // dispatch, null metadata) and the assistant's (at relay, usage) — so
        // we must select the ASSISTANT's by role, not the first finish by seq.
        const parts = await fetchParts(db, runId);
        const finish = parts.find(
          (p) => p.kind === "finish" && p.role === "assistant",
        );
        expect(finish, "assistant finish anchor present").toBeTruthy();
        expect(
          (finish!.metadata as { usage?: typeof usage }).usage,
        ).toMatchObject(usage);

        // And the v2 read path surfaces it on the assistant message metadata.
        const items = await listMessages(api, orgSlug, threadId);
        const assistant = items.find((m) => m.role === "assistant");
        expect(
          (assistant!.metadata as { usage?: typeof usage }).usage,
        ).toMatchObject(usage);
      }).toPass({ timeout: 20_000, intervals: [250, 500, 1000, 2000] });
    } finally {
      await daemon?.close();
      await db.end();
    }
  });

  test("run status transitions to completed on a done-terminated relay", async ({
    authedPage,
  }) => {
    test.setTimeout(CASE_TIMEOUT_MS);
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
      const { runId, workItem } = await dispatchAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        "finish cleanly",
      );
      const { body } = buildTurnRelayBody({
        messageId: `msg_conf_complete_${Date.now()}`,
        text: "done",
      });
      await relay(runId, workItem.runFenceToken, body);
      // The terminal status is written by the async durable projector, so poll
      // until the run transitions to completed.
      await expect(async () => {
        expect(await fetchThreadStatus(db, runId)).toBe("completed");
      }).toPass({ timeout: 20_000, intervals: [250, 500, 1000, 2000] });
    } finally {
      await daemon?.close();
      await db.end();
    }
  });

  test("run status transitions to failed on an error relay line", async ({
    authedPage,
  }) => {
    test.setTimeout(CASE_TIMEOUT_MS);
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
      const { runId, workItem } = await dispatchAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        "this run fails",
      );
      const { body } = buildErrorRelayBody({
        messageId: `msg_conf_fail_${Date.now()}`,
        text: "partial output before failure",
        code: "harness_error",
        message: "simulated harness failure",
      });
      // The relay is published in full; an in-band error line transitions the
      // run to failed via the kernel's onError path (in the projector).
      await relay(runId, workItem.runFenceToken, body);
      // The failed transition + error/finish parts are written by the async
      // durable projector, so poll until the run reaches the terminal state.
      await expect(async () => {
        expect(await fetchThreadStatus(db, runId)).toBe("failed");
        // An error part + finish anchor are persisted so the thread renders the
        // failure rather than a dangling in-progress message.
        const kinds = (await fetchParts(db, runId)).map((p) => p.kind);
        expect(kinds).toContain("error");
        expect(kinds).toContain("finish");
      }).toPass({ timeout: 20_000, intervals: [250, 500, 1000, 2000] });
    } finally {
      await daemon?.close();
      await db.end();
    }
  });

  test("claude-code session id round-trips into the next turn's resumeSessionRef", async ({
    authedPage,
  }) => {
    // Task 7 fix: a finish-anchor's codingAgentSessionId must survive the v2
    // parts read path so the NEXT turn's dispatch carries it as
    // harnessInput.resumeSessionRef. Drive TWO turns on one thread and assert
    // the second work item's harnessInput.resumeSessionRef === the first turn's
    // relayed session id.
    test.setTimeout(CASE_TIMEOUT_MS * 2);
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

      // ── Turn 1: relay a finish carrying a coding-agent session id ──────────
      const t1 = await dispatchAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        "first turn",
      );
      const sessionId = `cc-session-${Date.now()}`;
      const { body } = buildTurnRelayBody({
        messageId: `msg_conf_session_${Date.now()}`,
        text: "first answer",
        codingAgentSessionId: sessionId,
      });
      await relay(t1.runId, t1.workItem.runFenceToken, body);
      // Turn 1's terminal status + the folded session id are written by the
      // async durable projector. Turn 1 must be terminal AND its session id must
      // be folded onto the assistant message metadata (so the next turn's
      // history reader can find it) before turn 2 dispatches — poll until both
      // have projected.
      await expect(async () => {
        expect(await fetchThreadStatus(db, t1.runId)).toBe("completed");
        const afterT1 = await listMessages(api, orgSlug, threadId);
        const assistantT1 = afterT1.find((m) => m.role === "assistant");
        expect(
          (assistantT1!.metadata as { codingAgentSessionId?: string })
            .codingAgentSessionId,
        ).toBe(sessionId);
      }).toPass({ timeout: 20_000, intervals: [250, 500, 1000, 2000] });

      // ── Turn 2: dispatch again → the work item resumes the prior session ───
      const t2 = await dispatchAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        "second turn",
      );
      expect(t2.workItem.harnessInput.resumeSessionRef).toBe(sessionId);
    } finally {
      await daemon?.close();
      await db.end();
    }
  });

  test("duplicate relay lines (reconnect replay) do NOT duplicate parts", async ({
    authedPage,
  }) => {
    // The daemon resends the FULL prefix from seq 1 on reconnect; the cluster
    // dedupes by seq and parts are id-deduped (ON CONFLICT id DO NOTHING). POST
    // the same body twice and assert the part-row count is identical.
    test.setTimeout(CASE_TIMEOUT_MS);
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
      const { runId, workItem } = await dispatchAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        "replay me",
      );
      const { body, lineCount } = buildTurnRelayBody({
        messageId: `msg_conf_dup_${Date.now()}`,
        text: "idempotent answer",
      });

      // First relay: full prefix. The projector persists asynchronously, so
      // poll until the parts land, then snapshot the row count.
      const { lastSeq } = await relay(runId, workItem.runFenceToken, body);
      expect(lastSeq).toBe(lineCount);
      let countAfterFirst = 0;
      await expect(async () => {
        countAfterFirst = await fetchPartRowIdCount(db, runId);
        expect(countAfterFirst).toBeGreaterThanOrEqual(2);
      }).toPass({ timeout: 20_000, intervals: [250, 500, 1000, 2000] });

      // Second relay: identical full prefix (reconnect replay). JetStream
      // `Nats-Msg-Id` dedup drops the duplicate lines server-side, and parts are
      // id-deduped (ON CONFLICT id DO NOTHING) — so the row count is unchanged.
      await relay(runId, workItem.runFenceToken, body);
      // Give the projector a window to (not) add rows, then assert no growth.
      await sleep(3_000);
      const countAfterSecond = await fetchPartRowIdCount(db, runId);
      expect(countAfterSecond).toBe(countAfterFirst);
    } finally {
      await daemon?.close();
      await db.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Negative / authz conformance — the direct-NATS relay contract.
//
// These overlap link-ingest.spec.ts but are kept in the conformance suite as
// the relay-driver's "rejection" cases so the case list is self-contained.
// They seed the thread row directly (no dispatch needed) and assert the
// projector's gates (fence mismatch skipped, unknown run never projected)
// at the DB level — the old HTTP route's 409/404 responses are gone.
// ---------------------------------------------------------------------------

async function seedV2Thread(
  db: Db,
  {
    orgId,
    userId,
    runFenceToken,
  }: { orgId: string; userId: string; runFenceToken: string | null },
): Promise<string> {
  const threadId = `thrd_conf_neg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO threads
       (id, organization_id, title, status, virtual_mcp_id,
        message_storage_version, run_fence_token, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, 'in_progress', '', 2, $4, $5, $5, $6)`,
    [
      threadId,
      orgId,
      "Conformance negative thread",
      runFenceToken,
      now,
      userId,
    ],
  );
  return threadId;
}

test.describe("harness conformance — relay endpoint rejections", () => {
  test("mismatched fence stream is skipped and no parts land", async ({
    authedPage,
  }) => {
    // Fence enforcement moved from the (deleted) HTTP route to the projector:
    // `shouldSkipProjection` skips a stream whose fence differs from the run's
    // current run_fence_token, so a stale-fence relay commits nothing.
    const { user, orgSlug } = authedPage;
    const db = await connectDevDb();
    try {
      const orgId = await orgIdForSlug(db, orgSlug);
      const runId = await seedV2Thread(db, {
        orgId,
        userId: user.userId,
        runFenceToken: `fence_real_${Date.now()}`,
      });
      const { body } = buildTurnRelayBody({
        messageId: `msg_conf_stale_${Date.now()}`,
        text: "should not land",
      });
      await relay(runId, `fence_stale_${Date.now()}`, body);
      // Give the projector a window to observe + skip the mismatched stream,
      // then assert nothing was committed.
      await sleep(4_000);
      expect(await fetchParts(db, runId)).toHaveLength(0);
    } finally {
      await db.end();
    }
  });

  test("relayed stream for an unknown run persists nothing", async () => {
    // There is no cluster HTTP route to 404 a foreign/missing run anymore;
    // authz is enforced at the NATS publish layer (the daemon's scoped creds).
    // A stream for a runId with no thread row can't resolve an org, so the
    // projector consumer never schedules a projection — nothing is persisted.
    const db = await connectDevDb();
    try {
      const runId = `thrd_does_not_exist_${Date.now()}`;
      const { body } = buildTurnRelayBody({
        messageId: `msg_conf_foreign_${Date.now()}`,
        text: "should not land",
      });
      await relay(runId, `any_${Date.now()}`, body);
      await sleep(4_000);
      expect(await fetchParts(db, runId)).toHaveLength(0);
    } finally {
      await db.end();
    }
  });

  test("a full-prefix relay lands (idempotent resend, no session affinity)", async ({
    authedPage,
  }) => {
    // The old route parked an in-memory session and 410'd a resume that found
    // none. The direct-NATS path has no session affinity: a full-prefix relay
    // is always idempotent (JetStream `Nats-Msg-Id` dedup) and the projector
    // materializes it from seq 1.
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
      const { body } = buildTurnRelayBody({
        messageId: `msg_conf_lost_${Date.now()}`,
        text: "resumed turn lands",
      });
      await relay(runId, fenceToken, body);
      // Parts are written by the async durable projector, so poll until the
      // relay's lines land.
      await expect(async () => {
        expect((await fetchParts(db, runId)).length).toBeGreaterThan(0);
      }).toPass({ timeout: 20_000, intervals: [250, 500, 1000, 2000] });
    } finally {
      await db.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Offload conformance — the pull seam's body-offload happy path.
//
// Carry-forward from the deleted link-dispatch-offload.spec.ts (Task 11). A
// conversation whose encoded harnessInput exceeds NATS MAX_PUBLISH_BYTES
// (768 KiB) is offloaded cluster-side in pullDispatch: messages are PUT to
// object storage, `harnessInput.messages` becomes `[]` inline, and a
// `messagesRef` is carried on the work item. The e2e workflow boots MinIO +
// sets S3_* so ctx.objectStorage is the real S3Service path.
//
// Depth: this asserts the CLUSTER-SIDE offload decision (work item shape: ref
// present + messages emptied + ref fetchable). The daemon-side re-inflate
// (parseMessagesRef + splice back into input.messages, with SSRF allowlist) is
// unit-covered in offload-messages.test.ts / handle-local-dispatch.test.ts.
// ---------------------------------------------------------------------------

test.describe("harness conformance — pull-seam body offload", () => {
  test("a large message offloads → work item carries messagesRef + empty inline messages, ref is fetchable, then chunks relay + parts persist", async ({
    authedPage,
  }) => {
    test.setTimeout(CASE_TIMEOUT_MS);
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

      // > 768 KiB so the encoded harnessInput trips shouldOffload(). 1 MiB of
      // text is comfortably over the budget even after the rest of the wire
      // input adds overhead.
      const bigText = "x".repeat(1_024 * 1_024);
      const { runId, workItem } = await dispatchAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        bigText,
      );

      // The cluster-side offload decision: messagesRef present, inline messages
      // emptied. (When object storage is unavailable the offload falls through
      // and the work item would never publish — so a delivered work item with
      // a ref proves the production S3 path ran.)
      expect(
        workItem.messagesRef,
        "work item carries messagesRef for an over-budget conversation",
      ).toBeTruthy();
      expect(workItem.messagesRef!.url).toMatch(/^https?:\/\//);
      expect(workItem.messagesRef!.bytes).toBeGreaterThan(768 * 1024);
      expect(typeof workItem.messagesRef!.sha256).toBe("string");
      // Inline messages are emptied — the real messages live at the ref.
      expect(workItem.harnessInput.messages).toEqual([]);

      // The ref is fetchable (presigned GET) and matches the advertised size.
      const refRes = await api.get(workItem.messagesRef!.url);
      expect(refRes.status()).toBe(200);
      const refBytes = (await refRes.body()).byteLength;
      expect(refBytes).toBe(workItem.messagesRef!.bytes);

      // The return path still works: relay a normal turn → parts persist +
      // run completes. (The daemon re-inflate of the ref is unit-covered; here
      // we only prove the ref doesn't break the cluster-side relay/commit.)
      const { body } = buildTurnRelayBody({
        messageId: `msg_conf_offload_${Date.now()}`,
        text: "offloaded-turn-answer",
      });
      await relay(runId, workItem.runFenceToken, body);
      // Parts + terminal status are written by the async durable projector, so
      // poll until the run projects and completes.
      await expect(async () => {
        const kinds = (await fetchParts(db, runId)).map((p) => p.kind);
        expect(kinds).toContain("text");
        expect(kinds).toContain("finish");
        expect(await fetchThreadStatus(db, runId)).toBe("completed");
      }).toPass({ timeout: 20_000, intervals: [250, 500, 1000, 2000] });
    } finally {
      await daemon?.close();
      await db.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Hosted driver — NOT headless-runnable. Skipped with a precise TODO.
//
// The case list above asserts behaviors of the SHARED harness kernel
// (consumeHarnessStream), which the hosted path (dispatch-run.ts) and the relay
// path (link-ingest-routes.ts) both feed. The relay driver drives that kernel
// end-to-end, so these behaviors ARE verified for the shared layer. What the
// hosted driver would add is verification of the in-process CHUNK SOURCE (a
// real harness producing chunks), which CANNOT run headless in e2e:
//
//   - `harnessId: "decopilot"` forces per-request model resolution via
//     resolveTier, which 400s on an org with no model configured
//     (decopilot-messages.spec.ts documents this).
//   - A CLI harness (claude-code/codex) on agent-sandbox needs a real
//     sandbox + LLM to emit chunks.
//   - No mock-AI provider is wired into THIS e2e harness. (One exists in
//     tests/multi-pod, gated by STREAM_OF_RECORD_V2_PERCENT; porting it here
//     is the cleanest path to enabling this driver — see option (a) below.)
//
// TO ENABLE this driver in CI, ONE of:
//   (a) a mock-AI provider/model registered for e2e (deterministic chunk
//       output for a sentinel model id), wired so resolveTier resolves it
//       without a real credential; then trigger a hosted run and run the SAME
//       case-list assertions against the resulting thread; OR
//   (b) a real model credential + sandbox available in the e2e environment
//       (heavier; flakier; not recommended for the conformance gate).
//
// Until then, hosted CHUNK-SOURCE conformance is covered by the harness unit
// tests (cli-stream-metadata, run-core, usage-accumulator) + the gating e2e in
// decopilot-messages.spec.ts. Do NOT replace this skip with a faked pass.
// ---------------------------------------------------------------------------
test.describe("harness conformance — hosted driver", () => {
  test.skip("[needs mock-AI provider OR real model key] hosted run satisfies the same case list", () => {
    // Intentionally empty — see the block comment above for what this needs.
  });
});
