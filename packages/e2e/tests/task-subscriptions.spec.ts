/**
 * Task subscriptions and the inbox they feed.
 *
 * The rules this pins down are the ones that are silent when they break:
 *   - You are never notified about your own action.
 *   - Commenting subscribes you; the creator is subscribed at creation.
 *   - Unsubscribing sticks — a later auto-subscribe rule must not undo it.
 *   - Marking read clears the inbox without touching the subscription.
 *
 * The email digest is not covered here: there is no mail sink in CI, and
 * inventing one is out of scope. Candidate selection is asserted at the storage
 * tier instead.
 */

import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";
import { signUpViaApi } from "../fixtures/auth-api";

// Black-box wire-contract shapes (owned by this test, per e2e isolation rules).
interface TaskBoardItem {
  id: string;
  title: string;
}
interface SubscriptionState {
  subscriberIds: string[];
  subscribed: boolean;
}
interface InboxItem {
  id: string;
  taskBoardItemId: string;
  taskTitle: string;
  action: string;
  actorId: string | null;
  occurredAt: string;
}

test.describe("task subscriptions", () => {
  test("creating subscribes you, and your own changes never notify you", async ({
    authedPage,
  }) => {
    const { page, orgSlug, user } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    const { item } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Subscribe on create" },
    );

    const state = await call<SubscriptionState>("TASK_BOARD_SUBSCRIPTION_GET", {
      taskBoardItemId: item.id,
    });
    expect(state.subscribed).toBe(true);
    expect(state.subscriberIds).toContain(user.userId);

    // Every change so far is the subscriber's own, so the inbox stays empty.
    await call("TASK_BOARD_ITEM_UPDATE", {
      id: item.id,
      status: "in_progress",
    });
    await call("TASK_BOARD_COMMENT_CREATE", {
      taskBoardItemId: item.id,
      body: "talking to myself",
    });

    const inbox = await call<{ items: InboxItem[] }>("TASK_BOARD_INBOX_LIST", {
      limit: 50,
    });
    expect(
      inbox.items.filter((i) => i.taskBoardItemId === item.id),
    ).toHaveLength(0);
  });

  test("unsubscribing sticks, even after an action that would auto-subscribe", async ({
    authedPage,
  }) => {
    const { page, orgSlug, user } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    const { item } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Sticky opt-out" },
    );

    const off = await call<SubscriptionState>("TASK_BOARD_SUBSCRIPTION_SET", {
      taskBoardItemId: item.id,
      subscribed: false,
    });
    expect(off.subscribed).toBe(false);
    expect(off.subscriberIds).not.toContain(user.userId);

    // Commenting auto-subscribes — but must not override the explicit opt-out.
    await call("TASK_BOARD_COMMENT_CREATE", {
      taskBoardItemId: item.id,
      body: "still out",
    });
    const after = await call<SubscriptionState>("TASK_BOARD_SUBSCRIPTION_GET", {
      taskBoardItemId: item.id,
    });
    expect(after.subscribed).toBe(false);

    // Re-subscribing is still possible; the opt-out is sticky, not permanent.
    const on = await call<SubscriptionState>("TASK_BOARD_SUBSCRIPTION_SET", {
      taskBoardItemId: item.id,
      subscribed: true,
    });
    expect(on.subscriberIds).toContain(user.userId);
  });

  test("a teammate's comment lands in the subscriber's inbox, and clears on read", async ({
    authedPage,
    playwright,
  }) => {
    const { page, orgSlug, user: owner } = authedPage;
    const ownerRequest = page.context().request;
    const asOwner = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(ownerRequest, orgSlug, name, args);

    // A second principal needs its own cookie jar; `page`'s is the owner's.
    const mateCtx = await newApiContext(playwright);
    const mate = await signUpViaApi(mateCtx);
    await asOwner("ORGANIZATION_MEMBER_ADD", {
      userId: mate.userId,
      role: ["member"],
    });

    const { item } = await asOwner<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Cross-member notification" },
    );

    await callSelfMcpTool(mateCtx, orgSlug, "TASK_BOARD_COMMENT_CREATE", {
      taskBoardItemId: item.id,
      body: "took a look",
    });

    const inbox = await asOwner<{ items: InboxItem[] }>(
      "TASK_BOARD_INBOX_LIST",
      { limit: 50 },
    );
    const mine = inbox.items.filter((i) => i.taskBoardItemId === item.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      action: "commented",
      actorId: mate.userId,
      taskTitle: "Cross-member notification",
    });

    // The commenter is now subscribed too, so the card carries both of them.
    const subscribers = await asOwner<SubscriptionState>(
      "TASK_BOARD_SUBSCRIPTION_GET",
      { taskBoardItemId: item.id },
    );
    expect(subscribers.subscriberIds).toEqual(
      expect.arrayContaining([owner.userId, mate.userId]),
    );

    await asOwner("TASK_BOARD_INBOX_MARK_READ", {});
    const afterRead = await asOwner<{ items: InboxItem[] }>(
      "TASK_BOARD_INBOX_LIST",
      { limit: 50 },
    );
    expect(
      afterRead.items.filter((i) => i.taskBoardItemId === item.id),
    ).toHaveLength(0);

    // Reading is not unsubscribing: the next update comes back.
    await callSelfMcpTool(mateCtx, orgSlug, "TASK_BOARD_COMMENT_CREATE", {
      taskBoardItemId: item.id,
      body: "one more thing",
    });
    const again = await asOwner<{ items: InboxItem[] }>(
      "TASK_BOARD_INBOX_LIST",
      { limit: 50 },
    );
    expect(
      again.items.filter((i) => i.taskBoardItemId === item.id),
    ).toHaveLength(1);

    await mateCtx.dispose();
  });

  test("the dialog's Activity header carries the subscribe toggle", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    // The toggle is behind the org flag, which is off for a fresh org.
    const { organizationId } = await call<{ organizationId: string }>(
      "ORGANIZATION_SETTINGS_GET",
      {},
    );
    await call("ORGANIZATION_SETTINGS_UPDATE", {
      organizationId,
      flags: { task_notifications: true },
    });

    const title = `Toggle in the dialog ${Date.now()}`;
    await call("TASK_BOARD_ITEM_CREATE", { title });

    // A cold SPA paint of the board, twice (open, then reopen after reload).
    test.setTimeout(120_000);
    const openTask = async () => {
      await page.goto(`/${orgSlug}?main=board`);
      const card = page.getByText(title, { exact: true });
      await card.waitFor({ state: "visible", timeout: 60_000 });
      await card.click();
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 30_000 });
    };

    await openTask();

    // Created by this user, so the toggle offers the exit.
    const dialog = page.getByRole("dialog");
    const unsubscribe = dialog.getByRole("button", { name: "Unsubscribe" });
    await expect(unsubscribe).toBeVisible({ timeout: 30_000 });

    await unsubscribe.click();
    await expect(
      dialog.getByRole("button", { name: "Subscribe" }),
    ).toBeVisible();

    // The choice survives a reload — it is a row, not component state.
    await openTask();
    await expect(
      page.getByRole("dialog").getByRole("button", { name: "Subscribe" }),
    ).toBeVisible({ timeout: 30_000 });
  });
});
