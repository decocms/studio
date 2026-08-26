/**
 * E2E: the follow/inbox contract over the wire.
 *
 * Two halves, both load-bearing:
 *   - follow a task, have a teammate comment, and the inbox carries the row
 *     until you mark it read;
 *   - a member of ANOTHER org cannot subscribe to that task id. Subscribing is
 *     a write that grants future reads of task content, so an ungated
 *     NOTIFICATION_SUBSCRIPTION_SET is a cross-tenant leak.
 */

import type { APIRequestContext } from "@playwright/test";
import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool, findOrgId } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

// Black-box wire-contract shapes (owned by this test, per e2e isolation rules).
interface InboxRow {
  id: string;
  taskBoardItemId: string;
  type: string;
  taskTitle: string;
  actorName: string | null;
}

async function inviteAndAccept(
  ownerCtx: APIRequestContext,
  memberCtx: APIRequestContext,
  organizationId: string,
  email: string,
): Promise<void> {
  const invite = await ownerCtx.post("/api/auth/organization/invite-member", {
    data: { organizationId, email, role: "user" },
  });
  expect(invite.ok(), `invite failed: ${await invite.text()}`).toBe(true);
  const body = (await invite.json()) as {
    id?: string;
    invitation?: { id?: string };
  };
  const invitationId = body.id ?? body.invitation?.id;
  const accept = await memberCtx.post(
    "/api/auth/organization/accept-invitation",
    { data: { invitationId } },
  );
  expect(accept.ok(), `accept failed: ${await accept.text()}`).toBe(true);
}

test.describe("notifications inbox", () => {
  test("a followed task's comment reaches the follower's inbox, and clears when read", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const organizationId = await findOrgId(ownerCtx, owner.orgSlug);

    const mateCtx = await newApiContext(playwright);
    const mate = await signUpViaApi(mateCtx);
    await inviteAndAccept(ownerCtx, mateCtx, organizationId, mate.email);

    const { item } = await callSelfMcpTool<{ item: { id: string } }>(
      ownerCtx,
      owner.orgSlug,
      "TASK_BOARD_ITEM_CREATE",
      { title: "Watch me" },
    );

    // The creator is already enrolled by create; this is the teammate opting in.
    await callSelfMcpTool(
      mateCtx,
      owner.orgSlug,
      "NOTIFICATION_SUBSCRIPTION_SET",
      {
        taskBoardItemId: item.id,
        subscribed: true,
      },
    );
    const { userIds } = await callSelfMcpTool<{ userIds: string[] }>(
      ownerCtx,
      owner.orgSlug,
      "NOTIFICATION_SUBSCRIPTION_LIST",
      { taskBoardItemId: item.id },
    );
    expect(userIds.length).toBe(2);

    await callSelfMcpTool(
      ownerCtx,
      owner.orgSlug,
      "TASK_BOARD_COMMENT_CREATE",
      {
        taskBoardItemId: item.id,
        body: "ping",
      },
    );

    const inbox = await callSelfMcpTool<{
      notifications: InboxRow[];
      unreadCount: number;
    }>(mateCtx, owner.orgSlug, "NOTIFICATION_LIST", {});
    expect(inbox.unreadCount).toBe(1);
    expect(inbox.notifications[0]?.type).toBe("commented");
    expect(inbox.notifications[0]?.taskBoardItemId).toBe(item.id);
    expect(inbox.notifications[0]?.taskTitle).toBe("Watch me");

    // The actor is never notified of their own action.
    const actorInbox = await callSelfMcpTool<{ unreadCount: number }>(
      ownerCtx,
      owner.orgSlug,
      "NOTIFICATION_LIST",
      {},
    );
    expect(actorInbox.unreadCount).toBe(0);

    await callSelfMcpTool(mateCtx, owner.orgSlug, "NOTIFICATION_MARK_READ", {});
    const cleared = await callSelfMcpTool<{ unreadCount: number }>(
      mateCtx,
      owner.orgSlug,
      "NOTIFICATION_LIST",
      {},
    );
    expect(cleared.unreadCount).toBe(0);
  });

  test("a member of another org cannot subscribe to this org's task", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const { item } = await callSelfMcpTool<{ item: { id: string } }>(
      ownerCtx,
      owner.orgSlug,
      "TASK_BOARD_ITEM_CREATE",
      { title: "Not yours" },
    );

    const outsiderCtx = await newApiContext(playwright);
    const outsider = await signUpViaApi(outsiderCtx);

    // Through the outsider's OWN org, so only the task's org resolution can stop it.
    const res = await outsiderCtx.post(`/api/${outsider.orgSlug}/mcp/self`, {
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "NOTIFICATION_SUBSCRIPTION_SET",
          arguments: { taskBoardItemId: item.id, subscribed: true },
        },
      },
      headers: { Accept: "application/json, text/event-stream" },
    });
    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
      error?: { message?: string };
    };
    expect(
      body.result?.isError === true || !!body.error,
      `expected rejection, got ${JSON.stringify(body)}`,
    ).toBe(true);

    // And nothing was written: only the creator, enrolled at create time.
    const { userIds } = await callSelfMcpTool<{ userIds: string[] }>(
      ownerCtx,
      owner.orgSlug,
      "NOTIFICATION_SUBSCRIPTION_LIST",
      { taskBoardItemId: item.id },
    );
    expect(userIds.length).toBe(1);
  });
});
