/**
 * E2E: a thread is writable only by its owner — EXCEPT while it is paused
 * awaiting input (`requires_action`, e.g. a QA Agent / Code Reviewer
 * `user_ask`), where any org member may answer so the run isn't stuck on one
 * person.
 *
 * This is the black-box regression anchor for the ownership gate at request
 * ingress (`validate()` in decopilot `routes.ts`). It matters because the gate
 * reads `threads.status` BEFORE the dispatch gate mints a run fence — and the
 * fence flips the status to `in_progress`. An earlier placement of the check
 * (inside `prepareRun`, after the fence) read `in_progress` and rejected every
 * teammate response; only an end-to-end test over the real POST path catches
 * that timing bug, which a pure unit test of the decision function cannot.
 *
 * We do NOT drive `requires_action` through a real model run (that needs a
 * provider); we seed the status directly in the DB — the gate only reads the
 * column, so this exercises exactly the authorization decision, deterministically
 * and with no model dependency. The gate runs before model resolution, so the
 * ownership rejection surfaces regardless of whether the org has a usable model.
 */

import type { APIRequestContext } from "@playwright/test";
import { connectDevDb } from "../fixtures/db";
import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

type Db = Awaited<ReturnType<typeof connectDevDb>>;

const OWNERSHIP_ERROR = /not allowed to write|not the owner/i;

async function orgIdForSlug(db: Db, slug: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM organization WHERE slug = $1`,
    [slug],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`org not found for slug ${slug}`);
  return id;
}

async function setThreadStatus(
  db: Db,
  threadId: string,
  status: string,
): Promise<void> {
  await db.query(`UPDATE threads SET status = $2 WHERE id = $1`, [
    threadId,
    status,
  ]);
}

async function inviteAndAccept(
  ownerCtx: APIRequestContext,
  memberCtx: APIRequestContext,
  orgId: string,
  email: string,
): Promise<void> {
  const invite = await ownerCtx.post("/api/auth/organization/invite-member", {
    data: { organizationId: orgId, email, role: "user" },
  });
  expect(
    invite.ok(),
    `invite failed: ${await invite.text().catch(() => "")}`,
  ).toBe(true);
  const inviteJson = (await invite.json()) as {
    id?: string;
    invitation?: { id?: string };
  };
  const invitationId = inviteJson.id ?? inviteJson.invitation?.id;
  expect(invitationId).toBeTruthy();
  const accept = await memberCtx.post(
    "/api/auth/organization/accept-invitation",
    { data: { invitationId } },
  );
  expect(
    accept.ok(),
    `accept failed: ${await accept.text().catch(() => "")}`,
  ).toBe(true);
}

function postMessage(
  api: APIRequestContext,
  orgSlug: string,
  threadId: string,
  agentId: string,
) {
  return api.post(`/api/${orgSlug}/decopilot/threads/${threadId}/messages`, {
    data: {
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
      agent: { id: agentId },
      branch: "ephemeral",
      temperature: 0,
      sandboxProviderKind: "agent-sandbox",
      harnessId: "decopilot",
    },
    headers: { "content-type": "application/json" },
  });
}

/** The `{ error }` body the ingress gate returns; other failures (model
 *  resolution) also use this shape, so we match on the message, not the code. */
async function errorMessage(res: Awaited<ReturnType<typeof postMessage>>) {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? "";
}

test.describe("thread write access — requires_action exception", () => {
  let db: Db;

  test.beforeAll(async () => {
    db = await connectDevDb();
  });

  test.afterAll(async () => {
    await db?.end();
  });

  test("a teammate may answer only while the thread awaits input", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const orgId = await orgIdForSlug(db, owner.orgSlug);

    // Owner creates the agent + thread → thread.created_by = owner.
    const agent = await callSelfMcpTool<{ item: { id: string } }>(
      ownerCtx,
      owner.orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      { data: { title: "requires-action access e2e", connections: [] } },
    );
    const thread = await callSelfMcpTool<{ item: { id: string } }>(
      ownerCtx,
      owner.orgSlug,
      "COLLECTION_THREADS_CREATE",
      { data: { virtual_mcp_id: agent.item.id } },
    );
    const threadId = thread.item.id;
    const agentId = agent.item.id;

    // A second member of the SAME org (the non-owner teammate).
    const memberCtx = await newApiContext(playwright);
    const member = await signUpViaApi(memberCtx);
    await inviteAndAccept(ownerCtx, memberCtx, orgId, member.email);

    // DENY: teammate on a settled (completed) thread → owner-only rejection.
    // The gate runs before model resolution, so this is deterministic.
    await setThreadStatus(db, threadId, "completed");
    const deniedRes = await postMessage(
      memberCtx,
      owner.orgSlug,
      threadId,
      agentId,
    );
    expect(deniedRes.status()).toBe(403);
    expect(await errorMessage(deniedRes)).toMatch(OWNERSHIP_ERROR);

    // ALLOW: the SAME teammate on the SAME thread once it awaits input.
    // The only thing that changed is `status`, isolating the gate as the cause.
    // The request may still fail downstream (no model configured), but it must
    // NOT be the ownership rejection — that proves the gate let it through.
    await setThreadStatus(db, threadId, "requires_action");
    const allowedRes = await postMessage(
      memberCtx,
      owner.orgSlug,
      threadId,
      agentId,
    );
    expect(await errorMessage(allowedRes)).not.toMatch(OWNERSHIP_ERROR);

    // CONTROL: the owner is never blocked, even on a settled thread.
    await setThreadStatus(db, threadId, "completed");
    const ownerRes = await postMessage(
      ownerCtx,
      owner.orgSlug,
      threadId,
      agentId,
    );
    expect(await errorMessage(ownerRes)).not.toMatch(OWNERSHIP_ERROR);

    await ownerCtx.dispose();
    await memberCtx.dispose();
  });
});
