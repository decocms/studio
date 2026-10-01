/**
 * E2E: a person attaches files to a task comment, and deleting the comment
 * removes them.
 *
 * Drives the real browser, API and org filesystem. Confirms:
 *   1. Attached files upload when the comment is sent, under the task's folder.
 *   2. The posted comment previews the image and offers the file as a download
 *      under the name it was uploaded with.
 *   3. Deleting the comment deletes its files — but not one another comment
 *      on the task still links to.
 *   4. An edit that drops a link leaves the file, and deleting the task
 *      deletes whatever its comments still had.
 */

import type { APIRequestContext } from "@playwright/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";
import { TaskBoardPage } from "../pages/task-board";

/** Smallest valid PNG — 1x1, so `naturalWidth === 1` proves it really loaded. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

// Black-box wire-contract shape (owned by this test, per e2e isolation rules).
interface TaskComment {
  id: string;
  body: string;
}

/** The read URLs a comment body links to, in order. */
function uploadUrls(body: string): string[] {
  return [...body.matchAll(/\((\/api\/[^)\s]+\/fs\/uploads\/read\?[^)\s]+)\)/g)]
    .map((m) => m[1] ?? "")
    .filter(Boolean);
}

async function readStatus(request: APIRequestContext, url: string) {
  return (await request.get(url)).status();
}

test("a comment's attachments upload on send and go away with it", async ({
  authedPage,
}) => {
  test.setTimeout(180_000);
  const { page, orgSlug } = authedPage;
  const request = page.context().request;
  const call = <T>(name: string, args: unknown) =>
    callSelfMcpTool<T>(request, orgSlug, name, args);

  const title = `Attachments ${Date.now()}`;
  const { item } = await call<{ item: { id: string } }>(
    "TASK_BOARD_ITEM_CREATE",
    { title },
  );
  await new TaskBoardPage(page).openTask(orgSlug, title);

  const composer = page.getByTestId("new-comment-composer");
  await composer.locator('input[type="file"]').setInputFiles([
    { name: "shot.png", mimeType: "image/png", buffer: PNG },
    {
      name: "relatório (v2).pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n"),
    },
  ]);
  await composer.getByRole("textbox").pressSequentially("See attached");
  await composer.getByRole("button", { name: "Send", exact: true }).click();

  const post = page.getByTestId("task-detail").locator("[data-comment-id]");
  const image = post.getByRole("img", { name: "shot.png" });
  await expect(image).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth), {
      timeout: 30_000,
    })
    .toBe(1);
  await expect(post.locator('a[download="relatório (v2).pdf"]')).toBeVisible();

  const { comments } = await call<{ comments: TaskComment[] }>(
    "TASK_BOARD_COMMENT_LIST",
    { taskBoardItemId: item.id },
  );
  const [posted] = comments;
  expect(posted).toBeDefined();
  const urls = uploadUrls(posted!.body);
  const pngUrl = urls.find((url) => url.endsWith(".png"));
  const pdfUrl = urls.find((url) => url.endsWith(".pdf"));
  expect(pngUrl).toContain(
    `path=task-comments%2F${encodeURIComponent(item.id)}%2F`,
  );
  expect(pdfUrl).toMatch(/relatorio-v2-\.pdf$/);
  expect(await readStatus(request, pngUrl!)).toBe(200);
  expect(await readStatus(request, pdfUrl!)).toBe(200);

  // Another comment reuses the screenshot, so deleting the first keeps it.
  const { comment: second } = await call<{ comment: TaskComment }>(
    "TASK_BOARD_COMMENT_CREATE",
    { taskBoardItemId: item.id, body: `Same screenshot ![again](${pngUrl})` },
  );
  await call("TASK_BOARD_COMMENT_DELETE", { id: posted!.id });
  expect(await readStatus(request, pdfUrl!)).toBe(404);
  expect(await readStatus(request, pngUrl!)).toBe(200);

  // An edit that drops the link leaves the file; it goes with the task.
  await call("TASK_BOARD_COMMENT_UPDATE", {
    id: second.id,
    body: "Never mind the screenshot",
  });
  expect(await readStatus(request, pngUrl!)).toBe(200);

  // Deleting the task takes what its comments still link to.
  const notes = `task-comments/${item.id}/${crypto.randomUUID()}/notes.txt`;
  const put = await request.put(
    `/api/${orgSlug}/fs/uploads/file?${new URLSearchParams({ path: notes })}`,
    { data: Buffer.from("notes"), headers: { "content-type": "text/plain" } },
  );
  expect(put.ok()).toBe(true);
  const notesUrl = `/api/${orgSlug}/fs/uploads/read?${new URLSearchParams({ path: notes })}`;
  await call("TASK_BOARD_COMMENT_CREATE", {
    taskBoardItemId: item.id,
    body: `[notes.txt](${notesUrl})`,
  });
  await call("TASK_BOARD_ITEM_DELETE", { id: item.id });
  expect(await readStatus(request, notesUrl)).toBe(404);
  expect(await readStatus(request, pngUrl!)).toBe(404);
});
