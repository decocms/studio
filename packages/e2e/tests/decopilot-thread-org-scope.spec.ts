/**
 * E2E: a message posted to a thread id the caller's organization has no
 * thread under is refused, and nothing is stored under that id.
 *
 * Thread ids are global and the message route takes one from the path, while
 * message parts are read by thread id alone. Clients create the thread first,
 * so a missing row is either an id nobody created or another organization's
 * thread, and neither may take a message.
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
      label: "thread-org-scope-e2e",
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
        title: "thread org scope",
        connections: [],
        status: "active",
        pinned: false,
      },
    },
  );
  return { agentId: agent.item.id };
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
          parts: [{ type: "text", text: "hello" }],
        },
      ],
      agent: { id: agentId },
    },
    headers: { "content-type": "application/json" },
  });
}

test("a message for another organization's thread is refused, and nothing is stored", async ({
  authedPage,
  playwright,
}) => {
  const { page, orgSlug } = authedPage;
  const api = page.context().request;
  const db = await connectDevDb();
  const other = await newApiContext(playwright);
  try {
    const { agentId } = await configureOrg(api, db, orgSlug);
    const thread = await callSelfMcpTool<{ item: { id: string } }>(
      api,
      orgSlug,
      "COLLECTION_THREADS_CREATE",
      { data: { virtual_mcp_id: agentId } },
    );
    const threadId = thread.item.id;

    const otherUser = await signUpViaApi(other);
    const otherOrgId = await orgIdForSlug(db, otherUser.orgSlug);
    // With its own org active, as the app leaves a session.
    const setActive = await other.post("/api/auth/organization/set-active", {
      data: { organizationId: otherOrgId },
    });
    expect(setActive.ok()).toBe(true);
    // A complete setup in its own org, so a refusal is about the thread alone.
    const own = await configureOrg(other, db, otherUser.orgSlug);

    const messageId = `msg-other-org-${Date.now()}`;
    const viaOwnOrg = await postMessage(
      other,
      otherUser.orgSlug,
      threadId,
      own.agentId,
      messageId,
    );
    expect(viaOwnOrg.status()).toBe(404);
    const viaThreadsOrg = await postMessage(
      other,
      orgSlug,
      threadId,
      agentId,
      messageId,
    );
    expect(viaThreadsOrg.status()).toBe(403);

    const { rows } = await db.query(
      "SELECT 1 FROM thread_message_parts WHERE thread_id = $1 AND message_id = $2",
      [threadId, messageId],
    );
    expect(rows).toEqual([]);
  } finally {
    await other.dispose();
    await db.end();
  }
});

test("a message for a thread id nobody created is refused", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  const api = page.context().request;
  const db = await connectDevDb();
  try {
    const { agentId } = await configureOrg(api, db, orgSlug);
    const threadId = `thrd_never_created_${Date.now()}`;

    const res = await postMessage(api, orgSlug, threadId, agentId, "msg-1");

    expect(res.status()).toBe(404);
    const { rows } = await db.query(
      "SELECT 1 FROM threads WHERE id = $1 UNION ALL SELECT 1 FROM thread_message_parts WHERE thread_id = $1",
      [threadId],
    );
    expect(rows).toEqual([]);
  } finally {
    await db.end();
  }
});
