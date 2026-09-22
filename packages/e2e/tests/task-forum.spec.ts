import type { APIRequestContext } from "@playwright/test";
import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool, findOrgId } from "../fixtures/mcp-tools";
import { expect, newApiContext, test, getE2EAppOrigin } from "../fixtures/test";

interface Item {
  id: string;
}
interface Comment {
  id: string;
  body: string;
}
interface Conversation {
  comments: Comment[];
  unreadCommentIds: string[];
  notificationIds: string[];
}
interface ForumRow {
  id: string;
  rank: number;
  replyCount: number;
  unreadCount: number;
  mentionCount: number;
  participantIds: string[];
  lastReply: Comment | null;
  lastParticipatedAt: string | null;
}
interface ForumPage {
  items: ForumRow[];
  nextCursor: { rank: number; time: string; id: string } | null;
}
const call = <T>(
  context: APIRequestContext,
  org: string,
  name: string,
  input: unknown,
) => callSelfMcpTool<T>(context, org, name, input);

async function join(
  owner: APIRequestContext,
  member: APIRequestContext,
  orgId: string,
  email: string,
) {
  const response = await owner.post("/api/auth/organization/invite-member", {
    data: { organizationId: orgId, email, role: "user" },
    headers: { Origin: getE2EAppOrigin() },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const invitation = await response.json();
  const accepted = await member.post(
    "/api/auth/organization/accept-invitation",
    { data: { invitationId: invitation.id ?? invitation.invitation?.id } },
  );
  expect(accepted.ok()).toBe(true);
}

test.use({ compactPageLayout: true });

test("forum ranks unread, mentions, and workspace by recency, pages, and scopes read markers", async ({
  authedPage,
  playwright,
}) => {
  const { page, orgSlug, user } = authedPage;
  const owner = page.context().request;
  const member = await newApiContext(playwright);
  try {
    const second = await signUpViaApi(member);
    await join(owner, member, await findOrgId(owner, orgSlug), second.email);
    const create = async (title: string) =>
      (
        await call<{ item: Item }>(owner, orgSlug, "TASK_BOARD_ITEM_CREATE", {
          title,
        })
      ).item;
    const mentioned = await create("Mentioned conversation");
    const participated = await create("My recent conversation");
    const latest = await create("Workspace conversation");
    const post = async (ctx: APIRequestContext, item: Item, body: string) =>
      (
        await call<{ comment: Comment }>(
          ctx,
          orgSlug,
          "TASK_BOARD_COMMENT_CREATE",
          { taskBoardItemId: item.id, body },
        )
      ).comment;
    const first = await post(
      owner,
      mentioned,
      `A decision for [@Teammate](mention:${second.userId})`,
    );
    await post(member, participated, "My contribution");
    await post(owner, latest, "Newest workspace reply");
    const itemIds = [mentioned.id, participated.id, latest.id];
    const list = (options = {}) =>
      call<ForumPage>(member, orgSlug, "TASK_BOARD_FORUM_LIST", {
        itemIds,
        ...options,
      });
    const initial = await list();
    const expectedOrder = [latest.id, mentioned.id, participated.id];
    expect(initial.items.map((row) => row.id)).toEqual(expectedOrder);
    expect((await list()).items.map((row) => row.id)).toEqual(expectedOrder);
    expect(initial.items.map((row) => row.rank)).toEqual([0, 0, 2]);
    expect(initial.items[1]).toMatchObject({
      replyCount: 1,
      unreadCount: 1,
      mentionCount: 1,
      lastReply: { id: first.id },
    });
    expect(initial.items[2]).toMatchObject({
      unreadCount: 0,
      participantIds: [second.userId],
    });
    expect(
      (await list({ filter: "mentions" })).items.map((row) => row.id),
    ).toEqual([mentioned.id]);
    expect(
      (await list({ filter: "unread" })).items.map((row) => row.id),
    ).toEqual([latest.id, mentioned.id]);
    expect((await list({ sort: "latest" })).items[0]?.id).toBe(latest.id);
    // Reading comments without acknowledging the mention leaves a mention-only task.
    await call(member, orgSlug, "TASK_BOARD_CONVERSATION_MARK_READ", {
      taskBoardItemId: mentioned.id,
      throughCommentId: first.id,
    });
    const ranked = await list();
    expect(ranked.items.map((row) => row.id)).toEqual(expectedOrder);
    expect(ranked.items.map((row) => row.rank)).toEqual([0, 1, 2]);
    const firstPage = await list({ limit: 1 });
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await list({ limit: 1, cursor: firstPage.nextCursor });
    const thirdPage = await list({ limit: 1, cursor: secondPage.nextCursor });
    expect(
      [...firstPage.items, ...secondPage.items, ...thirdPage.items].map(
        (row) => row.id,
      ),
    ).toEqual(expectedOrder);
    expect(thirdPage.nextCursor).toBeNull();
    expect((await list({ itemIds: [] })).items).toEqual([]);

    const observed = await call<Conversation>(
      member,
      orgSlug,
      "TASK_BOARD_COMMENT_LIST",
      { taskBoardItemId: mentioned.id },
    );
    const newer = await post(owner, mentioned, "Arrived after the snapshot");
    await call(member, orgSlug, "TASK_BOARD_CONVERSATION_MARK_READ", {
      taskBoardItemId: mentioned.id,
      throughCommentId: first.id,
      notificationIds: observed.notificationIds,
    });
    let read = await call<Conversation>(
      member,
      orgSlug,
      "TASK_BOARD_COMMENT_LIST",
      { taskBoardItemId: mentioned.id },
    );
    expect(read.unreadCommentIds).toEqual([newer.id]);
    expect((await list({ filter: "mentions" })).items).toEqual([]);
    await call(member, orgSlug, "TASK_BOARD_CONVERSATION_MARK_READ", {
      taskBoardItemId: mentioned.id,
      throughCommentId: newer.id,
    });
    await call(member, orgSlug, "TASK_BOARD_CONVERSATION_MARK_READ", {
      taskBoardItemId: mentioned.id,
      throughCommentId: first.id,
    });
    read = await call<Conversation>(
      member,
      orgSlug,
      "TASK_BOARD_COMMENT_LIST",
      { taskBoardItemId: mentioned.id },
    );
    expect(read.unreadCommentIds).toEqual([]);
    expect(
      (await list()).items.find((row) => row.id === mentioned.id)
        ?.lastParticipatedAt,
    ).toBeNull();
    // Reading is not participation, and another viewer's read state is independent.
    const ownState = await call<ForumPage>(
      owner,
      orgSlug,
      "TASK_BOARD_FORUM_LIST",
      { itemIds: [participated.id] },
    );
    expect(ownState.items[0]?.unreadCount).toBe(1);
    const foreign = (
      await call<{ item: Item }>(
        member,
        second.orgSlug,
        "TASK_BOARD_ITEM_CREATE",
        { title: "Other tenant" },
      )
    ).item;
    expect(
      (
        await call<ForumPage>(owner, orgSlug, "TASK_BOARD_FORUM_LIST", {
          itemIds: [foreign.id],
        })
      ).items,
    ).toEqual([]);
    await expect(
      call(owner, orgSlug, "TASK_BOARD_CONVERSATION_MARK_READ", {
        taskBoardItemId: foreign.id,
        throughCommentId: null,
      }),
    ).rejects.toThrow();
    expect(user.userId).not.toBe(second.userId);
  } finally {
    await member.dispose();
  }
});

test("forum opens a wide detail, receives live replies, and reads them across reloads", async ({
  authedPage,
  playwright,
}, testInfo) => {
  test.setTimeout(180_000);
  const { page, orgSlug, user } = authedPage;
  const owner = page.context().request;
  const remote = await newApiContext(playwright);
  try {
    const teammate = await signUpViaApi(remote);
    await join(owner, remote, await findOrgId(owner, orgSlug), teammate.email);
    const { item } = await call<{ item: Item }>(
      owner,
      orgSlug,
      "TASK_BOARD_ITEM_CREATE",
      {
        title: "Discuss the checkout flow",
        description: "A concise brief for a wider conversation.",
      },
    );
    await call(remote, orgSlug, "TASK_BOARD_COMMENT_CREATE", {
      taskBoardItemId: item.id,
      body: `Please review [@Owner](mention:${user.userId})`,
    });
    for (const [index, title] of [
      "Remember where I left off",
      "A better first five minutes",
      "One set of buttons, everywhere",
      "Polish the mobile gallery",
    ].entries()) {
      const { item: extra } = await call<{ item: Item }>(
        index < 2 ? owner : remote,
        orgSlug,
        "TASK_BOARD_ITEM_CREATE",
        { title },
      );
      await call(remote, orgSlug, "TASK_BOARD_COMMENT_CREATE", {
        taskBoardItemId: extra.id,
        body: "The updated proposal is ready. Let’s keep the next step clear and make room for the conversation.",
      });
    }
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(`/${orgSlug}/tasks`);
    await page.getByRole("button", { name: "List view", exact: true }).click();
    const row = page
      .getByTestId("task-forum-row")
      .filter({ hasText: "Discuss the checkout flow" });
    await expect(row).toContainText("Mentioned you");
    await expect(row).toContainText("Please review");
    await expect(
      page.getByText("Pick up where you left off", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Around the workspace", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "List view", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", { name: "Board view", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    await page.screenshot({
      path: testInfo.outputPath("forum.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await page.getByRole("option", { name: "Mentions", exact: true }).click();
    await expect(row).toBeVisible();
    await expect(page.getByTestId("task-forum-row")).toHaveCount(1);
    await page.getByRole("button", { name: "Unread", exact: true }).click();
    await expect(page).toHaveURL(/forumFilter=unread_mentions/);
    await expect(row).toBeVisible();
    await expect(page.getByTestId("task-forum-row")).toHaveCount(1);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Unread", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", { name: "Filter", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("combobox", { name: "Sort conversations" }),
    ).toHaveCount(0);
    await expect(row).toBeVisible();
    await row.click();
    const detail = page.getByTestId("task-detail");
    await expect(
      detail.getByRole("heading", { name: "Discuss the checkout flow" }),
    ).toBeVisible();
    await expect(page.getByTestId("task-unread-divider")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("detail.png"),
      fullPage: true,
    });
    const inspector = page.getByTestId("task-inspector");
    const before = await page
      .getByTestId("task-conversation-scroll")
      .boundingBox();
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await expect(inspector).toBeHidden();
    const after = await page
      .getByTestId("task-conversation-scroll")
      .boundingBox();
    expect(after!.width).toBeGreaterThan(before!.width);
    await detail
      .getByRole("button", { name: "The brief", exact: true })
      .click();
    await expect(page.getByTestId("task-description")).toBeHidden();
    await call(remote, orgSlug, "TASK_BOARD_COMMENT_CREATE", {
      taskBoardItemId: item.id,
      body: "A reply from another tab",
    });
    await expect(
      detail.getByText("A reply from another tab", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(
        async () =>
          (
            await call<Conversation>(
              owner,
              orgSlug,
              "TASK_BOARD_COMMENT_LIST",
              { taskBoardItemId: item.id },
            )
          ).unreadCommentIds,
      )
      .toEqual([]);
    await page.reload();
    await expect(
      detail.getByRole("heading", { name: "Discuss the checkout flow" }),
    ).toBeVisible();
    await expect(page.getByTestId("task-unread-divider")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("new-comment-composer")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("mobile-detail.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await remote.dispose();
  }
});

test("reading removes tasks from Unread on breadcrumb, browser back, and another tab without a refresh prompt", async ({
  authedPage,
  playwright,
}) => {
  test.setTimeout(120_000);
  const { page, orgSlug } = authedPage;
  const owner = page.context().request;
  const remote = await newApiContext(playwright);
  try {
    const teammate = await signUpViaApi(remote);
    await join(owner, remote, await findOrgId(owner, orgSlug), teammate.email);
    const items: Item[] = [];
    for (const title of [
      "Read and use Tasks",
      "Read and use browser back",
      "Read in another tab",
    ]) {
      const { item } = await call<{ item: Item }>(
        owner,
        orgSlug,
        "TASK_BOARD_ITEM_CREATE",
        { title, description: "A short conversation." },
      );
      await call(remote, orgSlug, "TASK_BOARD_COMMENT_CREATE", {
        taskBoardItemId: item.id,
        body: "A new unread reply.",
      });
      items.push(item);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/${orgSlug}/tasks?view=list&forumFilter=unread`);
    const rows = page.getByTestId("task-forum-row");
    const updatePrompt = page.getByRole("button", {
      name: "Show new activity",
      exact: true,
    });
    await expect(rows).toHaveCount(3);
    for (const [index, title] of [
      "Read and use Tasks",
      "Read and use browser back",
    ].entries()) {
      const saved = page.waitForResponse(
        (response) =>
          response.url().includes("/tools/TASK_BOARD_CONVERSATION_MARK_READ") &&
          response.ok(),
      );
      await rows.filter({ hasText: title }).click();
      await expect(
        page.getByTestId("task-detail").getByRole("heading", { name: title }),
      ).toBeVisible();
      await saved;
      if (index === 0) {
        await page
          .getByRole("navigation", { name: "Breadcrumbs" })
          .getByRole("button", { name: "Tasks", exact: true })
          .click();
      } else {
        await page.goBack();
      }
      await expect(
        page.getByRole("button", { name: "Unread", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(rows.filter({ hasText: title })).toHaveCount(0);
      await expect(rows).toHaveCount(2 - index);
      await expect(updatePrompt).toHaveCount(0);
    }
    // A second client acknowledges the same user's conversation while the
    // first is looking at the list: the SSE event must refresh it directly.
    const item = items[2]!;
    const observed = await call<Conversation>(
      owner,
      orgSlug,
      "TASK_BOARD_COMMENT_LIST",
      { taskBoardItemId: item.id },
    );
    await call(owner, orgSlug, "TASK_BOARD_CONVERSATION_MARK_READ", {
      taskBoardItemId: item.id,
      throughCommentId: observed.comments.at(-1)!.id,
      notificationIds: observed.notificationIds,
    });
    await expect(rows).toHaveCount(0, { timeout: 10_000 });
    await expect(updatePrompt).toHaveCount(0);
    await page.getByRole("button", { name: "Unread", exact: true }).click();
    await expect(rows).toHaveCount(3);
    await expect(
      page
        .getByTestId("task-forum")
        .getByLabel("1 unread replies", { exact: true }),
    ).toHaveCount(0);
  } finally {
    await remote.dispose();
  }
});
