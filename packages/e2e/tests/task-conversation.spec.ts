import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { connectDevDb } from "../fixtures/db";
import { expect, test } from "../fixtures/test";

test.use({ compactPageLayout: true });

test("task conversation keeps replies chronological and details accessible", async ({
  authedPage,
}) => {
  test.setTimeout(180_000);
  const { page, orgSlug } = authedPage;
  await page.setViewportSize({ width: 1440, height: 900 });
  const call = <T>(name: string, args: unknown) =>
    callSelfMcpTool<T>(page.context().request, orgSlug, name, args);
  const { item } = await call<{ item: { id: string } }>(
    "TASK_BOARD_ITEM_CREATE",
    {
      title: "Forum conversation",
      description:
        "## Original request\n\n" +
        "A detailed paragraph about the requested change.\n\n".repeat(25),
    },
  );
  for (const body of [
    "First reply",
    "Second reply",
    "Reference: https://example.com/specification",
  ]) {
    await call("TASK_BOARD_COMMENT_CREATE", { taskBoardItemId: item.id, body });
  }
  await page.goto(`/${orgSlug}/tasks`);
  await page.getByText("Forum conversation", { exact: true }).click();
  const detail = page.getByTestId("task-detail");
  await expect(
    detail.getByRole("heading", { name: "Forum conversation" }),
  ).toBeVisible();
  await expect(
    page.getByTestId("task-description").locator('[contenteditable="true"]'),
  ).toHaveCount(0);
  const inspector = page.getByTestId("task-inspector");
  await expect(
    inspector.getByRole("link", { name: "https://example.com/specification" }),
  ).toBeVisible();
  await expect(
    inspector.getByRole("button", { name: "Backlog", exact: true }),
  ).toBeVisible();
  const posts = detail.locator("[data-comment-id]");
  await expect(posts).toHaveCount(3);
  await expect(posts.nth(0)).toContainText("First reply");
  await expect(posts.nth(1)).toContainText("Second reply");
  await expect(detail.getByRole("textbox")).toHaveCount(1);
  await expect(
    detail.getByRole("button", { name: "Edit", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByTestId("task-conversation-scroll")
      .getByText("Backlog", { exact: true }),
  ).toHaveCount(0);

  const composer = page.getByTestId("new-comment-composer");
  const before = await composer.boundingBox();
  await page
    .getByRole("button", { name: "Jump to latest", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Jump to latest", exact: true }),
  ).toBeHidden();
  const after = await composer.boundingBox();
  expect(before).not.toBeNull();
  expect(after?.y).toBe(before?.y);
  await composer.getByRole("textbox").fill("Newest reply");
  await composer.getByRole("textbox").press("Enter");
  await expect(posts.last()).toContainText("Newest reply");
  await expect(composer.getByRole("textbox")).toBeEmpty();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(inspector).toBeHidden();
  await expect(composer).toBeVisible();
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await expect(inspector).toBeVisible();
  await expect(
    inspector.getByRole("button", { name: "Backlog", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await expect(composer).toBeVisible();
});

test("agent summaries and reports share a message layout and open their source chat", async ({
  authedPage,
}) => {
  test.setTimeout(180_000);
  const { page, orgSlug, user } = authedPage;
  const call = <T>(name: string, args: unknown) =>
    callSelfMcpTool<T>(page.context().request, orgSlug, name, args);
  const { item } = await call<{ item: { id: string } }>(
    "TASK_BOARD_ITEM_CREATE",
    { title: "Linked run messages" },
  );
  const { comment } = await call<{
    comment: { id: string; threadId: string | null };
  }>("TASK_BOARD_COMMENT_CREATE", {
    taskBoardItemId: item.id,
    body: "**Review complete**. See the linked run for details.",
  });
  expect(comment.threadId).toBeNull();
  const threadId = `thrd_e2e_forum_${item.id}`;
  const db = await connectDevDb();
  try {
    const { rows } = await db.query<{ organization_id: string }>(
      "SELECT organization_id FROM task_board_items WHERE id = $1",
      [item.id],
    );
    const orgId = rows[0]!.organization_id;
    // Source-run attribution is only stamped inside agent execution, not exposed as a user mutation.
    await db.query(
      "INSERT INTO threads (id, organization_id, title, status, message_storage_version, created_by) VALUES ($1, $2, $3, 'completed', 2, $4)",
      [threadId, orgId, "Reviewer: Linked run messages", user.userId],
    );
    await db.query(
      "INSERT INTO task_board_item_threads (task_board_item_id, thread_id, organization_id) VALUES ($1, $2, $3)",
      [item.id, threadId, orgId],
    );
    await db.query(
      "UPDATE task_board_comments SET thread_id = $1, author_id = 'super-agent' WHERE id = $2 AND task_board_item_id = $3",
      [threadId, comment.id, item.id],
    );
  } finally {
    await db.end();
  }
  const { comments } = await call<{
    comments: { id: string; threadId: string | null }[];
  }>("TASK_BOARD_COMMENT_LIST", { taskBoardItemId: item.id });
  expect(comments.find((entry) => entry.id === comment.id)?.threadId).toBe(
    threadId,
  );
  await page.goto(`/${orgSlug}/tasks`);
  await page.getByText("Linked run messages", { exact: true }).click();
  const messages = page.getByTestId("task-message");
  await expect(messages).toHaveCount(2);
  await expect(messages.getByRole("button", { name: "Open chat" })).toHaveCount(
    2,
  );
  const report = page.locator(`[data-comment-id="${comment.id}"]`);
  await expect(report.locator("strong")).toHaveText("Review complete");
  await expect(report.getByText("Reviewer", { exact: true })).toBeVisible();
  const taskUrl = page.url();
  await report.getByRole("button", { name: "Open chat" }).click();
  await expect(page.getByTestId("task-thread-sheet")).toBeVisible();
  await expect(page).toHaveURL(taskUrl);
  await page.keyboard.press("Escape");
  await messages
    .filter({ hasText: "Completed" })
    .getByRole("button", { name: "Open chat" })
    .click();
  await expect(page.getByTestId("task-thread-sheet")).toBeVisible();
  await expect(page).toHaveURL(taskUrl);
});
