import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

test.use({ compactPageLayout: false });

test("classic task details keep inline editing, newest-first cards, and replies", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  const call = <T>(name: string, args: unknown) =>
    callSelfMcpTool<T>(page.context().request, orgSlug, name, args);
  const { item } = await call<{ item: { id: string } }>(
    "TASK_BOARD_ITEM_CREATE",
    {
      title: "Classic task layout",
      description: "Classic description",
    },
  );
  for (const body of ["First comment", "Second comment"]) {
    await call("TASK_BOARD_COMMENT_CREATE", { taskBoardItemId: item.id, body });
  }
  const forumCalls: string[] = [];
  page.on("request", (request) => {
    if (/TASK_BOARD_(FORUM_LIST|CONVERSATION_MARK_READ)/.test(request.url()))
      forumCalls.push(request.url());
  });
  await page.goto(`/${orgSlug}/tasks?view=list&forumFilter=unread_mentions`);
  await expect(page.getByTestId("task-forum")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Unread", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Mentions", exact: true }),
  ).toHaveCount(0);
  await page.getByText("Classic task layout", { exact: true }).click();
  const detail = page.getByTestId("task-detail");
  await expect(
    detail.getByRole("heading", { name: "Activity", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("task-conversation-scroll")).toHaveCount(0);
  await expect(page.getByTestId("task-message")).toHaveCount(0);
  await expect(
    detail.getByRole("button", { name: "Edit", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByTestId("task-description").locator('[contenteditable="true"]'),
  ).toBeVisible();
  await expect(page.getByTestId("reply-composer")).toHaveCount(2);
  const first = detail.getByText("First comment", { exact: true });
  const second = detail.getByText("Second comment", { exact: true });
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  expect((await second.boundingBox())!.y).toBeLessThan(
    (await first.boundingBox())!.y,
  );
  await page
    .getByTestId("reply-composer")
    .first()
    .getByRole("textbox")
    .fill("Classic reply");
  await page
    .getByTestId("reply-composer")
    .first()
    .getByRole("textbox")
    .press("Enter");
  await expect(
    detail.getByText("Classic reply", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("task-inspector")).toBeVisible();
  await expect(
    detail.getByRole("button", { name: "Details", exact: true }),
  ).toHaveCount(0);
  expect(forumCalls).toEqual([]);
});
