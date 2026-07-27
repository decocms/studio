/**
 * E2E: a thread is a room — several people, several agents.
 *
 * Two contracts, both asserted over the wire against the real
 * `POST /api/:org/decopilot/threads/:threadId/messages` route:
 *
 *   1. WHO MAY POST. A personal chat takes messages from its owner alone; a
 *      shared room (`metadata.shared`) takes them from any member of the org.
 *      The check runs in the route's `validate()`, BEFORE model resolution and
 *      before the user message is persisted — so a refusal is a 403 on the POST
 *      with nothing written, not a 202 followed by a run that dies inside the
 *      workflow. That ordering is what makes this spec model-free: no AI
 *      provider, no harness, no link daemon is needed to prove it.
 *
 *   2. WHICH AGENT ANSWERS. The agent is per-request (`agent.id` in the body),
 *      never read from `threads.virtual_mcp_id`, so a second agent can answer
 *      in a thread another agent opened. The room keeps its primary agent — the
 *      thread row must not follow the turn.
 *
 * The "accepted" cases assert 202 + a persisted user message rather than a
 * finished run: completing a run needs a real model, and the surface under test
 * is admission, not generation.
 */

import type { APIRequestContext, PlaywrightWorkerArgs } from "@playwright/test";
import type { Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

function messageBody(agentId: string, text: string) {
  return {
    messages: [{ role: "user", parts: [{ type: "text", text }] }],
    agent: { id: agentId },
    temperature: 0.5,
  };
}

function postMessage(
  api: APIRequestContext,
  orgSlug: string,
  threadId: string,
  body: unknown,
) {
  return api.post(`/api/${orgSlug}/decopilot/threads/${threadId}/messages`, {
    data: body,
    headers: { "content-type": "application/json" },
  });
}

async function createAgent(
  api: APIRequestContext,
  orgSlug: string,
  title: string,
): Promise<string> {
  const agent = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    { data: { title, connections: [], status: "active", pinned: false } },
  );
  return agent.item.id;
}

async function createThread(
  api: APIRequestContext,
  orgSlug: string,
  virtualMcpId: string,
): Promise<string> {
  const thread = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_THREADS_CREATE",
    { data: { virtual_mcp_id: virtualMcpId, title: "E2E Room" } },
  );
  return thread.item.id;
}

/** Sign a second person up and pull them into `orgId` as a plain member. */
async function inviteTeammate(
  playwright: PlaywrightWorkerArgs["playwright"],
  ownerApi: APIRequestContext,
  orgId: string,
) {
  const teammateApi = await newApiContext(playwright);
  const teammate = await signUpViaApi(teammateApi);

  const invite = await ownerApi.post("/api/auth/organization/invite-member", {
    data: { organizationId: orgId, email: teammate.email, role: "user" },
  });
  expect(
    invite.ok(),
    `invite-member failed: ${await invite.text().catch(() => "")}`,
  ).toBe(true);
  const inviteJson = (await invite.json()) as {
    id?: string;
    invitation?: { id?: string };
  };
  const invitationId = inviteJson.id ?? inviteJson.invitation?.id;
  expect(invitationId).toBeTruthy();

  const accept = await teammateApi.post(
    "/api/auth/organization/accept-invitation",
    { data: { invitationId } },
  );
  expect(
    accept.ok(),
    `accept-invitation failed: ${await accept.text().catch(() => "")}`,
  ).toBe(true);

  return { teammateApi, teammate };
}

/** User-message rows persisted for a thread, tenant-scoped by thread id (the
 *  thread was minted inside this test's own org). */
async function userMessageCount(db: Client, threadId: string) {
  const { rows } = await db.query<{ count: string }>(
    `SELECT COUNT(DISTINCT message_id) AS count
       FROM thread_message_parts
      WHERE thread_id = $1 AND role = 'user'`,
    [threadId],
  );
  return Number(rows[0]?.count ?? 0);
}

test.describe("thread as a room", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();
  });

  test.afterAll(async () => {
    // `db` is undefined when beforeAll itself failed to connect — don't bury
    // that error under a TypeError from the teardown.
    await db?.end();
  });

  test("a teammate cannot post in someone's personal chat", async ({
    authedPage,
    playwright,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;

    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM "organization" WHERE slug = $1`,
      [orgSlug],
    );
    const orgId = rows[0]?.id;
    if (!orgId) throw new Error("org not found after signup");

    const agentId = await createAgent(api, orgSlug, "E2E Room Agent");
    const threadId = await createThread(api, orgSlug, agentId);

    const { teammateApi } = await inviteTeammate(playwright, api, orgId);
    try {
      const res = await postMessage(
        teammateApi,
        orgSlug,
        threadId,
        messageBody(agentId, "let me in"),
      );

      expect(res.status()).toBe(403);
      // Refused at the boundary: nothing of theirs was written.
      expect(await userMessageCount(db, threadId)).toBe(0);
    } finally {
      await teammateApi.dispose();
    }
  });

  test("a teammate can post in a shared room", async ({
    authedPage,
    playwright,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;

    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM "organization" WHERE slug = $1`,
      [orgSlug],
    );
    const orgId = rows[0]?.id;
    if (!orgId) throw new Error("org not found after signup");

    const agentId = await createAgent(api, orgSlug, "E2E Room Agent");
    const threadId = await createThread(api, orgSlug, agentId);

    // Open the thread as a room — the same write the UI's "Shared room" toggle
    // performs (thread update with `metadata.shared`).
    await callSelfMcpTool(api, orgSlug, "COLLECTION_THREADS_UPDATE", {
      id: threadId,
      data: { metadata: { shared: true } },
    });

    const { teammateApi } = await inviteTeammate(playwright, api, orgId);
    try {
      const res = await postMessage(
        teammateApi,
        orgSlug,
        threadId,
        messageBody(agentId, "joining the room"),
      );

      expect(
        res.status(),
        `expected the room to admit a member, got ${await res
          .text()
          .catch(() => "")}`,
      ).toBe(202);

      // Admission is proven by the message landing: the route persists the user
      // turn before handing off to the run.
      await expect(async () => {
        expect(await userMessageCount(db, threadId)).toBe(1);
      }).toPass({ timeout: 10_000, intervals: [200, 500, 1000] });
    } finally {
      await teammateApi.dispose();
    }
  });

  test("a second agent answers in a thread the first one opened", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;

    const marioId = await createAgent(api, orgSlug, "E2E Mario");
    const luigiId = await createAgent(api, orgSlug, "E2E Luigi");
    const threadId = await createThread(api, orgSlug, marioId);

    // Address the turn to the OTHER agent — what an "@Luigi" mention sends.
    const res = await postMessage(
      api,
      orgSlug,
      threadId,
      messageBody(luigiId, "@Luigi your turn"),
    );
    expect(
      res.status(),
      `expected the room to accept a second agent, got ${await res
        .text()
        .catch(() => "")}`,
    ).toBe(202);

    // The room keeps its primary agent: a turn handed to another agent must not
    // re-point the thread, or the sidebar would move the room under Luigi.
    const { rows } = await db.query<{ virtual_mcp_id: string }>(
      `SELECT virtual_mcp_id FROM threads WHERE id = $1`,
      [threadId],
    );
    expect(rows[0]?.virtual_mcp_id).toBe(marioId);
  });
});
