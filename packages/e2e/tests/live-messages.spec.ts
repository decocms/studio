/**
 * E2E: a message sent while a claude-code turn is running.
 *
 * `POST .../messages` tries to deliver the message into the running turn
 * through the sandbox daemon (`POST /_sandbox/runs/:runId/messages`). This
 * suite has no sandbox, so it
 * asserts the Studio side of the contract: the response says where the message
 * went, a message that cannot be delivered is queued exactly as before (stored
 * once, with no run on it), and nothing reaches another organization's thread.
 * Delivery itself is asserted against the real daemon in
 * `packages/sandbox/daemon-e2e/daemon.dispatch.e2e.test.ts`.
 *
 * A running turn has no API: `status`, the run fence and the runtime pin are
 * written by dispatch, so they are seeded here directly.
 */
import type { APIRequestContext } from "@playwright/test";
import { signUpViaApi } from "../fixtures/auth-api";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

type Db = Awaited<ReturnType<typeof connectDevDb>>;

async function orgIdForSlug(db: Db, slug: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM organization WHERE slug = $1",
    [slug],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`org not found for slug ${slug}`);
  return id;
}

/** A model the route can resolve and an agent, in `orgSlug`. */
async function configureOrg(
  api: APIRequestContext,
  db: Db,
  orgSlug: string,
): Promise<{ agentId: string }> {
  const organizationId = await orgIdForSlug(db, orgSlug);
  // A stored key is enough for the route to resolve a model; it is never called.
  const key = await callSelfMcpTool<{ id: string }>(
    api,
    orgSlug,
    "AI_PROVIDER_KEY_CREATE",
    {
      providerId: "anthropic",
      label: "live-messages-e2e",
      apiKey: "sk-ant-e2e-fake-key-do-not-use",
    },
  );
  await callSelfMcpTool(api, orgSlug, "ORGANIZATION_SETTINGS_UPDATE", {
    organizationId,
    simple_mode: {
      tiers: {
        fast: null,
        smart: { keyId: key.id, modelId: "claude-sonnet-4-6" },
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
        title: "live messages",
        connections: [],
        status: "active",
        pinned: false,
      },
    },
  );
  return { agentId: agent.item.id };
}

/** A claude-code thread with a turn running, in `orgSlug`. */
async function runningClaudeCodeThread(
  api: APIRequestContext,
  db: Db,
  orgSlug: string,
  userId: string,
): Promise<{ threadId: string; agentId: string }> {
  const { agentId } = await configureOrg(api, db, orgSlug);
  const thread = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_THREADS_CREATE",
    { data: { virtual_mcp_id: agentId } },
  );
  const running = await db.query(
    `UPDATE threads
        SET harness_id = 'claude-code',
            status = 'in_progress',
            run_fence_token = 'fence-e2e',
            message_storage_version = 2
      WHERE id = $1 AND created_by = $2`,
    [thread.item.id, userId],
  );
  expect(running.rowCount).toBe(1);
  return { threadId: thread.item.id, agentId };
}

function postMessage(
  api: APIRequestContext,
  orgSlug: string,
  threadId: string,
  agentId: string,
  messageId: string,
) {
  return api.post(`/api/${orgSlug}/decopilot/threads/${threadId}/messages`, {
    data: {
      messages: [
        {
          id: messageId,
          role: "user",
          parts: [{ type: "text", text: "also update the changelog" }],
        },
      ],
      agent: { id: agentId },
    },
    headers: { "content-type": "application/json" },
  });
}

/** The stored rows of one message, scoped to its thread. */
async function storedMessage(db: Db, threadId: string, messageId: string) {
  const { rows } = await db.query<{
    kind: string;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT kind, metadata FROM thread_message_parts
      WHERE thread_id = $1 AND message_id = $2`,
    [threadId, messageId],
  );
  return rows;
}

test.describe("live messages to a running claude-code turn", () => {
  test("a run that cannot take it falls back to the queue, once per message id", async ({
    authedPage,
  }) => {
    const { page, orgSlug, user } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    try {
      const { threadId, agentId } = await runningClaudeCodeThread(
        api,
        db,
        orgSlug,
        user.userId,
      );
      const messageId = `msg-fallback-${Date.now()}`;
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await postMessage(
          api,
          orgSlug,
          threadId,
          agentId,
          messageId,
        );
        expect(res.status()).toBe(202);
        expect(await res.json()).toEqual({
          taskId: threadId,
          delivery: "queued",
        });
      }
      // Stored once, and not as delivered: the queued turn carries it.
      const rows = await storedMessage(db, threadId, messageId);
      expect(rows.map((row) => row.kind).sort()).toEqual(["finish", "text"]);
      expect(
        rows.find((row) => row.kind === "finish")?.metadata?.liveRunId,
      ).toBeUndefined();
    } finally {
      await db.end();
    }
  });

  test("a message for another organization's thread is refused", async ({
    authedPage,
    playwright,
  }) => {
    const { page, orgSlug, user } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    const intruder = await newApiContext(playwright);
    try {
      const { threadId, agentId } = await runningClaudeCodeThread(
        api,
        db,
        orgSlug,
        user.userId,
      );
      const other = await signUpViaApi(intruder);
      const otherOrgId = await orgIdForSlug(db, other.orgSlug);
      // With the intruder's own org active, as the app leaves a session.
      const setActive = await intruder.post(
        "/api/auth/organization/set-active",
        { data: { organizationId: otherOrgId } },
      );
      expect(setActive.ok()).toBe(true);
      // Everything the route needs in the intruder's own org, so a refusal
      // can only be about the thread.
      const own = await configureOrg(intruder, db, other.orgSlug);

      const messageId = `msg-intruder-${Date.now()}`;
      // Through the intruder's own org, with its own agent…
      const viaOwnOrg = await postMessage(
        intruder,
        other.orgSlug,
        threadId,
        own.agentId,
        messageId,
      );
      expect(viaOwnOrg.status()).toBe(404);
      // …and through the victim's, which the intruder is not a member of.
      const viaVictimOrg = await postMessage(
        intruder,
        orgSlug,
        threadId,
        agentId,
        messageId,
      );
      expect(viaVictimOrg.status()).toBe(403);
      expect(await storedMessage(db, threadId, messageId)).toEqual([]);
    } finally {
      await intruder.dispose();
      await db.end();
    }
  });
});
