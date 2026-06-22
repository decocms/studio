/**
 * E2E: CLI session resume — codex harness, desktop-link relay path.
 *
 * Validates that:
 *   (a) A first turn's relay carrying `codingAgentSessionId` +
 *       `codingAgentProvider: "codex"` lands on the persisted assistant message
 *       metadata so the NEXT dispatch can read it back.
 *   (b) A second turn's dispatch work item carries
 *       `harnessInput.resumeSessionRef` equal to the first turn's session id —
 *       i.e., the cluster correctly threads a Codex session across turns.
 *   (c) A "stale session" error relay (what the daemon sends when the codex
 *       harness throws `CliSessionExpiredError`) persists an error part whose
 *       message matches /session expired/i and transitions the run to "failed".
 *
 * Architecture note: the relay driver is the SAME `consumeHarnessStream`
 * kernel both hosted and daemon-relayed paths feed. These tests drive it
 * through the pull-relay path (daemon tunnel → POST /chunks) exactly as
 * `harness-conformance.spec.ts` does — the only codex-specific detail is
 * `harness_id = 'codex'` on the thread row and
 * `codingAgentProvider: "codex"` in the relayed finish chunk.
 *
 * Scenario (c) note: the relay driver cannot restart a real daemon process or
 * wipe `~/.codex/sessions`. Instead we inject the exact error relay body that
 * the daemon sends after catching `CliSessionExpiredError` — a
 * `harness_crashed` error event whose `message` is "Session expired — start a
 * new thread." (see `packages/sandbox/daemon/routes/dispatch.ts:142`). This
 * faithfully exercises the cluster-side error-part persistence and run-status
 * transition without requiring a live daemon restart.
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
import { DEFAULT_THREAD_TITLE } from "@decocms/harness/decopilot/prompt-constants";
import type { APIRequestContext } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers (mirror harness-conformance.spec.ts)
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
  }>(api, orgSlug, "COLLECTION_THREAD_MESSAGES_LIST", {
    thread_id: threadId,
  });
  return result.items;
}

/**
 * Create an agent (virtual MCP) + a v2 thread pinned to user-desktop /
 * CODEX so POST /messages routes to the pull gate without per-request model
 * resolution. Mirrors createPullThread in harness-conformance.spec.ts but
 * pins harness_id to "codex".
 */
async function createCodexPullThread(
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
        title: "CLI Session Resume E2E Agent",
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

  // Pin the pull-transport columns with harness_id = 'codex'. The dispatch
  // route reads harness_id off this row to route the work item to the daemon.
  await db.query(
    `UPDATE threads
     SET message_storage_version = 2,
         harness_id              = 'codex',
         sandbox_provider_kind   = 'user-desktop',
         title                   = $3
     WHERE id = $1
       AND organization_id = $2`,
    [threadId, orgId, DEFAULT_THREAD_TITLE],
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
 * Trigger a dispatch by POSTing a user message with harnessId: "codex",
 * then wait for the tunnel daemon to receive the matching work item.
 */
async function dispatchCodexAndClaimWorkItem(
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
        harnessId: "codex",
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

  return { runId, workItem: workItem as unknown as WorkItem };
}

/** POST a canned NDJSON chunk-relay body as the fake daemon. */
function postRelay(
  api: APIRequestContext,
  orgSlug: string,
  runId: string,
  fenceToken: string,
  body: string,
  fromSeq = 1,
) {
  return api.post(`/api/${orgSlug}/links/runs/${runId}/chunks`, {
    headers: {
      "content-type": "application/x-ndjson",
      "x-fence-token": fenceToken,
      "x-relay-from": String(fromSeq),
    },
    data: body,
  });
}

// Per-test budget: setup + dispatch + claim work item + relay + reads.
const CASE_TIMEOUT_MS = 130_000;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe("CLI session resume (codex, desktop-link relay)", () => {
  test("first turn: relayed codingAgentSessionId + codingAgentProvider:codex persist on the assistant message metadata", async ({
    authedPage,
  }) => {
    test.setTimeout(CASE_TIMEOUT_MS);
    const { page, orgSlug, user } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    let daemon: TunnelLinkDaemon | null = null;
    try {
      daemon = await createTunnelLinkDaemon(api, user.userId, ["codex"]);
      const orgId = await orgIdForSlug(db, orgSlug);
      const { agentId, threadId } = await createCodexPullThread(
        api,
        db,
        orgSlug,
        orgId,
      );
      const { runId, workItem } = await dispatchCodexAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        "Remember the number 42.",
      );

      const sessionId = `codex-session-${Date.now()}`;
      const { body } = buildTurnRelayBody({
        messageId: `msg_resume_t1_${Date.now()}`,
        text: "ok",
        codingAgentSessionId: sessionId,
        codingAgentProvider: "codex",
      });
      const res = await postRelay(
        api,
        orgSlug,
        runId,
        workItem.runFenceToken,
        body,
      );
      expect(res.status()).toBe(200);

      // The session id + provider must land on the assistant message
      // metadata so the NEXT turn's dispatch can read it back. Persistence
      // is async (durable projector); poll until both have projected.
      await expect(async () => {
        expect(await fetchThreadStatus(db, runId)).toBe("completed");
        const items = await listMessages(api, orgSlug, threadId);
        const assistant = items.find((m) => m.role === "assistant");
        expect(assistant, "assistant message projected").toBeTruthy();
        const meta = assistant!.metadata as {
          codingAgentSessionId?: string;
          codingAgentProvider?: string;
        };
        expect(meta.codingAgentSessionId).toBe(sessionId);
        expect(meta.codingAgentProvider).toBe("codex");
      }).toPass({ timeout: 20_000, intervals: [250, 500, 1000, 2000] });
    } finally {
      await daemon?.close();
      await db.end();
    }
  });

  test("second turn: dispatch work item carries resumeSessionRef from the prior codex session", async ({
    authedPage,
  }) => {
    // Drives TWO turns on one codex-pinned thread and asserts the second
    // work item's harnessInput.resumeSessionRef equals the first turn's
    // relayed session id — proving the round-trip across the v2 read path.
    test.setTimeout(CASE_TIMEOUT_MS * 2);
    const { page, orgSlug, user } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    let daemon: TunnelLinkDaemon | null = null;
    try {
      daemon = await createTunnelLinkDaemon(api, user.userId, ["codex"]);
      const orgId = await orgIdForSlug(db, orgSlug);
      const { agentId, threadId } = await createCodexPullThread(
        api,
        db,
        orgSlug,
        orgId,
      );

      // ── Turn 1: relay a finish carrying a codex session id ────────────
      const t1 = await dispatchCodexAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        "Remember the number 42. Reply 'ok'.",
      );
      const sessionId = `codex-session-${Date.now()}`;
      const { body: body1 } = buildTurnRelayBody({
        messageId: `msg_resume_round1_${Date.now()}`,
        text: "ok",
        codingAgentSessionId: sessionId,
        codingAgentProvider: "codex",
      });
      const res1 = await postRelay(
        api,
        orgSlug,
        t1.runId,
        t1.workItem.runFenceToken,
        body1,
      );
      expect(res1.status()).toBe(200);

      // Turn 1 must be terminal AND the session id must be folded onto the
      // assistant message metadata before turn 2 dispatches — poll until
      // both have projected (the async durable projector writes them).
      await expect(async () => {
        expect(await fetchThreadStatus(db, t1.runId)).toBe("completed");
        const afterT1 = await listMessages(api, orgSlug, threadId);
        const assistantT1 = afterT1.find((m) => m.role === "assistant");
        expect(
          (assistantT1!.metadata as { codingAgentSessionId?: string })
            .codingAgentSessionId,
        ).toBe(sessionId);
      }).toPass({ timeout: 20_000, intervals: [250, 500, 1000, 2000] });

      // ── Turn 2: the work item must resume the prior codex session ──────
      const t2 = await dispatchCodexAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        "What number did I ask you to remember?",
      );
      expect(t2.workItem.harnessInput.resumeSessionRef).toBe(sessionId);
    } finally {
      await daemon?.close();
      await db.end();
    }
  });

  test("stale codex session relay propagates as a session-expired error", async ({
    authedPage,
  }) => {
    // A real desktop daemon, when the codex harness throws
    // `CliSessionExpiredError`, sends to the cluster:
    //   { type: "error", code: "harness_crashed",
    //     message: "Session expired — start a new thread." }
    // (see packages/sandbox/daemon/routes/dispatch.ts:142).
    //
    // We inject that relay body directly — the relay driver has no mechanism to
    // restart a real daemon process or wipe `~/.codex/sessions`. This exercises
    // the SAME cluster-side code path: error-part persistence + run-status
    // transition to "failed".
    test.setTimeout(CASE_TIMEOUT_MS);
    const { page, orgSlug, user } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    let daemon: TunnelLinkDaemon | null = null;
    try {
      daemon = await createTunnelLinkDaemon(api, user.userId, ["codex"]);
      const orgId = await orgIdForSlug(db, orgSlug);
      const { agentId, threadId } = await createCodexPullThread(
        api,
        db,
        orgSlug,
        orgId,
      );

      const { runId, workItem } = await dispatchCodexAndClaimWorkItem(
        api,
        orgSlug,
        agentId,
        threadId,
        daemon,
        "What number?",
      );

      // Inject the error relay body the daemon sends after catching
      // CliSessionExpiredError ("Session expired — start a new thread.").
      const { body } = buildErrorRelayBody({
        messageId: `msg_stale_${Date.now()}`,
        code: "harness_crashed",
        message: "Session expired — start a new thread.",
      });
      const res = await postRelay(
        api,
        orgSlug,
        runId,
        workItem.runFenceToken,
        body,
      );
      expect(res.status()).toBe(200);

      // The kernel's onError path persists an error part + transitions the run
      // to "failed". Both are written by the async durable projector — poll
      // until they land.
      await expect(async () => {
        expect(await fetchThreadStatus(db, runId)).toBe("failed");
        const parts = await fetchParts(db, runId);
        const errorPart = parts.find((p) => p.kind === "error");
        expect(errorPart, "error part persisted").toBeTruthy();
        const payload = errorPart!.payload as { message?: string } | null;
        expect(payload?.message ?? "").toMatch(/session expired/i);
      }).toPass({ timeout: 20_000, intervals: [250, 500, 1000, 2000] });
    } finally {
      await daemon?.close();
      await db.end();
    }
  });
});
