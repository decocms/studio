/**
 * E2E: thread WRITES (update/delete) are owner-only.
 *
 * Thread READS are org-wide by design — teammates can view each other's chats
 * (COLLECTION_THREADS_LIST/GET). But the write tools must reject a non-owner
 * member: "teammates' threads must be read-only unless owned" (CLAUDE.md /
 * PR #4230). Because the thread collection tools are basic-usage (granted to
 * every org member regardless of role), `ctx.access.check()` alone passes for
 * any member — the ownership guard is the only thing standing between member B
 * and member A's thread. This spec pins that boundary over the real wire.
 *
 * Matrix (single org, all members):
 *   - member B UPDATE A's thread  → DENIED
 *   - member B DELETE A's thread  → DENIED
 *   - member A UPDATE own thread  → ALLOWED (owner)
 *   - org owner DELETE A's thread → ALLOWED (admin/owner bypass)
 */

import type { APIRequestContext } from "@playwright/test";
import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool, findOrgId } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

const FORBIDDEN = /only the chat's owner or an organization admin/;

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

test.describe("thread write ownership guard", () => {
  test("non-owner member cannot update/delete a teammate's thread; owner & admin can", async ({
    playwright,
  }) => {
    // Org owner.
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const orgSlug = owner.orgSlug;
    const orgId = await findOrgId(ownerCtx, orgSlug);

    // Two plain "user"-role members of the same org.
    const memberACtx = await newApiContext(playwright);
    const memberA = await signUpViaApi(memberACtx);
    await inviteAndAccept(ownerCtx, memberACtx, orgId, memberA.email);

    const memberBCtx = await newApiContext(playwright);
    const memberB = await signUpViaApi(memberBCtx);
    await inviteAndAccept(ownerCtx, memberBCtx, orgId, memberB.email);

    // Member A creates an agent and a thread owned by A.
    const agent = await callSelfMcpTool<{ item: { id: string } }>(
      memberACtx,
      orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      { data: { title: "owner-guard agent", connections: [] } },
    );
    const virtualMcpId = agent.item?.id;
    expect(virtualMcpId).toBeTruthy();

    const created = await callSelfMcpTool<{ item: { id: string } }>(
      memberACtx,
      orgSlug,
      "COLLECTION_THREADS_CREATE",
      { data: { title: "A's private chat", virtual_mcp_id: virtualMcpId } },
    );
    const threadId = created.item?.id;
    expect(threadId).toBeTruthy();

    // Sanity: member B CAN read A's thread (reads are org-wide by design).
    const readByB = await callSelfMcpTool<{ item: { id: string } }>(
      memberBCtx,
      orgSlug,
      "COLLECTION_THREADS_GET",
      { id: threadId },
    );
    expect(readByB.item?.id).toBe(threadId);

    // DENY: member B updates A's thread.
    await expect(
      callSelfMcpTool(memberBCtx, orgSlug, "COLLECTION_THREADS_UPDATE", {
        id: threadId,
        data: { title: "hijacked by B" },
      }),
    ).rejects.toThrow(FORBIDDEN);

    // DENY: member B deletes A's thread.
    await expect(
      callSelfMcpTool(memberBCtx, orgSlug, "COLLECTION_THREADS_DELETE", {
        id: threadId,
      }),
    ).rejects.toThrow(FORBIDDEN);

    // ALLOW: member A (owner) updates their own thread.
    const updatedByA = await callSelfMcpTool<{ item: { title: string } }>(
      memberACtx,
      orgSlug,
      "COLLECTION_THREADS_UPDATE",
      { id: threadId, data: { title: "renamed by A" } },
    );
    expect(updatedByA.item?.title).toBe("renamed by A");

    // ALLOW: org owner (admin bypass) deletes A's thread.
    const deletedByOwner = await callSelfMcpTool<{ item: { id: string } }>(
      ownerCtx,
      orgSlug,
      "COLLECTION_THREADS_DELETE",
      { id: threadId },
    );
    expect(deletedByOwner.item?.id).toBe(threadId);

    await ownerCtx.dispose();
    await memberACtx.dispose();
    await memberBCtx.dispose();
  });
});
