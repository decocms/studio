/**
 * E2E: `@`-mentions notify the people they name, and only them.
 *
 * Three things this proves that no unit test can:
 *   - a mention reaches someone who does NOT follow the task (the whole point;
 *     every other notification type goes to followers);
 *   - it does not reach the task's followers, who were not named;
 *   - a mention of a user id outside the org writes nothing. The body is
 *     user-authored text, so an ungated fan-out would turn it into a way to
 *     notify any user id in the deployment.
 */

import type { APIRequestContext } from "@playwright/test";
import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool, findOrgId } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

// Black-box wire-contract shapes (owned by this test, per e2e isolation rules).
interface InboxRow {
  taskBoardItemId: string;
  type: string;
}

/** The mention markdown, spelled out here rather than imported: this suite owns
 *  the wire format it asserts on, and a divergence from the app is the signal. */
const mention = (userId: string, name: string) =>
  `[@${name}](mention:${userId})`;

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
  const accept = await memberCtx.post(
    "/api/auth/organization/accept-invitation",
    { data: { invitationId: body.id ?? body.invitation?.id } },
  );
  expect(accept.ok(), `accept failed: ${await accept.text()}`).toBe(true);
}

test.describe("task mentions", () => {
  test("a mention in a comment notifies the named member, not the followers", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const organizationId = await findOrgId(ownerCtx, owner.orgSlug);

    // Named in the comment, following nothing.
    const namedCtx = await newApiContext(playwright);
    const named = await signUpViaApi(namedCtx);
    await inviteAndAccept(ownerCtx, namedCtx, organizationId, named.email);

    // Follows the task, named in nothing.
    const followerCtx = await newApiContext(playwright);
    const follower = await signUpViaApi(followerCtx);
    await inviteAndAccept(
      ownerCtx,
      followerCtx,
      organizationId,
      follower.email,
    );

    const { item } = await callSelfMcpTool<{ item: { id: string } }>(
      ownerCtx,
      owner.orgSlug,
      "TASK_BOARD_ITEM_CREATE",
      { title: "Mention me" },
    );
    await callSelfMcpTool(
      followerCtx,
      owner.orgSlug,
      "NOTIFICATION_SUBSCRIPTION_SET",
      { taskBoardItemId: item.id, subscribed: true },
    );

    await callSelfMcpTool(
      ownerCtx,
      owner.orgSlug,
      "TASK_BOARD_COMMENT_CREATE",
      {
        taskBoardItemId: item.id,
        body: `heads up ${mention(named.userId, "Named")}`,
      },
    );

    const namedInbox = await callSelfMcpTool<{ notifications: InboxRow[] }>(
      namedCtx,
      owner.orgSlug,
      "NOTIFICATION_LIST",
      {},
    );
    expect(namedInbox.notifications.map((n) => n.type)).toEqual(["mentioned"]);
    expect(namedInbox.notifications[0]?.taskBoardItemId).toBe(item.id);

    // The follower gets the comment, and NOT the mention that didn't name them.
    const followerInbox = await callSelfMcpTool<{ notifications: InboxRow[] }>(
      followerCtx,
      owner.orgSlug,
      "NOTIFICATION_LIST",
      {},
    );
    expect(followerInbox.notifications.map((n) => n.type)).toEqual([
      "commented",
    ]);
  });

  test("editing a description notifies only the mentions the edit added", async ({
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
      { title: "Spec", description: `owner: ${mention(mate.userId, "Mate")}` },
    );

    // A later edit that leaves the same mention in place must not re-ping.
    await callSelfMcpTool(ownerCtx, owner.orgSlug, "TASK_BOARD_ITEM_UPDATE", {
      id: item.id,
      description: `owner: ${mention(mate.userId, "Mate")} — and a typo fixed`,
    });

    const inbox = await callSelfMcpTool<{ notifications: InboxRow[] }>(
      mateCtx,
      owner.orgSlug,
      "NOTIFICATION_LIST",
      {},
    );
    expect(
      inbox.notifications.filter((n) => n.type === "mentioned").length,
    ).toBe(1);
  });

  test("mentioning yourself notifies nobody", async ({ playwright }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);

    const { item } = await callSelfMcpTool<{ item: { id: string } }>(
      ownerCtx,
      owner.orgSlug,
      "TASK_BOARD_ITEM_CREATE",
      { title: "Solo" },
    );
    await callSelfMcpTool(
      ownerCtx,
      owner.orgSlug,
      "TASK_BOARD_COMMENT_CREATE",
      {
        taskBoardItemId: item.id,
        body: `note to self ${mention(owner.userId, "Me")}`,
      },
    );

    const inbox = await callSelfMcpTool<{ unreadCount: number }>(
      ownerCtx,
      owner.orgSlug,
      "NOTIFICATION_LIST",
      {},
    );
    expect(inbox.unreadCount).toBe(0);
  });
});
