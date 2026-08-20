/**
 * E2E: the task description is a rich-text editor whose stored value is
 * markdown.
 *
 * Drives the real browser end-to-end. Confirms:
 *   1. Markdown shortcuts apply while typing (`# ` becomes a heading).
 *   2. The syntax markers themselves are not left on screen.
 *   3. What's saved is markdown, not HTML.
 *   4. Reopening the task renders the saved markdown as rich text.
 */

import type { Page } from "@playwright/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

/** Cold-Vite first paint on a fresh sandbox is slow (SPA compile + auth). */
const FIRST_PAINT_MS = 60_000;

const DOC_NAME = "spec.txt";
const DOC = Buffer.from("attachment body\n");

const PNG_NAME = "shot.png";
/** Smallest valid PNG — 1x1, so `naturalWidth === 1` proves it really loaded. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

/**
 * The description editor's contenteditable. Scoped to the dialog and matched on
 * the editor surface rather than its accessible name, which is derived from the
 * placeholder and so only exists while the description is empty — this test
 * asserts on it both empty and filled.
 */
function editorOf(page: Page) {
  return page.getByRole("dialog").locator(".ProseMirror");
}

// Black-box wire-contract shape (owned by this test, per e2e isolation rules).
interface TaskBoardItem {
  id: string;
  title: string;
  description: string | null;
}

/**
 * Close the dialog, which is how a description gets written now: the card
 * autosaves as you type and closing flushes whatever the debounce still holds.
 * There is no Save button to click.
 */
async function closeTask(page: Page) {
  // The button, not Escape: tiptap swallows Escape while the editor has focus.
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

async function openTask(page: Page, orgSlug: string, title: string) {
  await page.goto(`/${orgSlug}?main=board`);
  const card = page.getByText(title, { exact: true });
  await card.waitFor({ state: "visible", timeout: FIRST_PAINT_MS });
  await card.click();
  await editorOf(page).waitFor({ state: "visible", timeout: FIRST_PAINT_MS });
}

test.describe("task description markdown editor", () => {
  test("applies markdown while typing and saves markdown", async ({
    authedPage,
  }) => {
    // Two cold SPA paints (open, then reopen after save) plus keystroke-by-
    // keystroke typing don't fit the default per-test budget.
    test.setTimeout(180_000);
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    const title = `Rich description ${Date.now()}`;
    const { item } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title },
    );

    await openTask(page, orgSlug, title);

    const editor = editorOf(page);
    await editor.click();
    // Tiptap is contenteditable, so page.fill() is unsupported — real
    // keystrokes are what fire the input rules under test. The inter-key delay
    // yields to the event loop so a re-render can't swallow the burst.
    await page.keyboard.type("# Heading here", { delay: 15 });
    await page.keyboard.press("Enter");
    await page.keyboard.type("some **bold** words", { delay: 15 });

    // 1 + 2: the heading and the bold rendered, and neither the `#` nor the
    // `**` survived as visible text.
    await expect(editor.locator("h1")).toHaveText("Heading here");
    await expect(editor.locator("strong")).toHaveText("bold");
    await expect(editor).not.toContainText("#");
    await expect(editor).not.toContainText("**");

    await closeTask(page);

    // 3: markdown on the wire, not HTML.
    await expect
      .poll(async () => {
        const { items } = await call<{ items: TaskBoardItem[] }>(
          "TASK_BOARD_ITEM_LIST",
          {},
        );
        return items.find((i) => i.id === item.id)?.description ?? null;
      })
      .toBe("# Heading here\n\nsome **bold** words");

    // 4: reopening renders the saved markdown as rich text again.
    await openTask(page, orgSlug, title);
    const reopened = editorOf(page);
    await expect(reopened.locator("h1")).toHaveText("Heading here");
    await expect(reopened.locator("strong")).toHaveText("bold");
    await expect(reopened).not.toContainText("**");
  });

  test("shows an attached image as a preview, not a URL, and can remove it", async ({
    authedPage,
  }) => {
    test.setTimeout(180_000);
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    const title = `Image description ${Date.now()}`;
    const { item } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title },
    );

    await openTask(page, orgSlug, title);
    const dialog = page.getByRole("dialog");
    const editor = editorOf(page);

    await dialog
      .locator('input[type="file"]')
      .setInputFiles({ name: PNG_NAME, mimeType: "image/png", buffer: PNG });

    // Rendered as an actual image, and its URL is nowhere in the visible text.
    // `img[src]`: ProseMirror adds 0×0 `ProseMirror-separator` images of its own.
    const img = editor.locator("img[src]");
    await expect(img).toBeVisible({ timeout: 30_000 });
    await expect(editor).not.toContainText("![");
    await expect(editor).not.toContainText("/fs/uploads/");

    // The upload really landed: the browser fetched it back successfully.
    const src = await img.getAttribute("src");
    // The dir separator arrives percent-encoded — the URL is built with
    // URLSearchParams.
    expect(src).toContain("/fs/uploads/read?path=editor-images%2F");
    // Polled, not read once: the element is visible as soon as it's laid out,
    // and the bytes land a beat later.
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), {
        timeout: 30_000,
      })
      .toBe(1);

    await closeTask(page);

    // Persisted as markdown image syntax, with the file name as alt text.
    await expect
      .poll(async () => {
        const { items } = await call<{ items: TaskBoardItem[] }>(
          "TASK_BOARD_ITEM_LIST",
          {},
        );
        return items.find((i) => i.id === item.id)?.description ?? null;
      })
      .toMatch(
        /^!\[shot\.png\]\(\/api\/[^/]+\/fs\/uploads\/read\?path=editor-images%2F[\w-]+\.png\)$/,
      );

    // Reopen: still a preview, and the X removes it.
    await openTask(page, orgSlug, title);
    const reopened = editorOf(page).locator("img[src]");
    await expect(reopened).toBeVisible();

    await reopened.hover();
    await page.getByRole("button", { name: "Remove image" }).click();
    await expect(reopened).toHaveCount(0);

    await closeTask(page);
    await expect
      .poll(async () => {
        const { items } = await call<{ items: TaskBoardItem[] }>(
          "TASK_BOARD_ITEM_LIST",
          {},
        );
        return items.find((i) => i.id === item.id)?.description ?? null;
      })
      .toBe(null);
  });

  test("shows a non-image attachment as a download chip that survives a reopen", async ({
    authedPage,
  }) => {
    test.setTimeout(180_000);
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    const title = `File description ${Date.now()}`;
    const { item } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title },
    );

    await openTask(page, orgSlug, title);
    const dialog = page.getByRole("dialog");
    const editor = editorOf(page);

    await dialog.locator('input[type="file"]').setInputFiles({
      name: DOC_NAME,
      mimeType: "text/plain",
      buffer: DOC,
    });

    // A named chip with a download control — no preview, no raw markdown, no URL.
    const download = page.getByRole("link", { name: `Download ${DOC_NAME}` });
    await expect(download).toBeVisible({ timeout: 30_000 });
    await expect(editor).toContainText(DOC_NAME);
    await expect(editor).not.toContainText("/fs/uploads/");
    // `img[src]`: an inline atom gets a 0×0 `ProseMirror-separator` img beside it.
    await expect(editor.locator("img[src]")).toHaveCount(0);

    // The download really points at the uploaded bytes, under the attachment
    // dir (not the image one), and saves under the name it was uploaded with.
    const href = await download.getAttribute("href");
    expect(href).toContain("/fs/uploads/read?path=editor-files%2F");
    await expect(download).toHaveAttribute("download", DOC_NAME);
    const fetched = await request.get(href ?? "");
    expect(fetched.status()).toBe(200);
    expect(await fetched.text()).toBe(DOC.toString());

    await closeTask(page);

    // Persisted as a plain markdown link — legible to whatever reads the
    // description next, including the agent it's fed to as context.
    await expect
      .poll(async () => {
        const { items } = await call<{ items: TaskBoardItem[] }>(
          "TASK_BOARD_ITEM_LIST",
          {},
        );
        return items.find((i) => i.id === item.id)?.description ?? null;
      })
      .toMatch(
        /^\[spec\.txt\]\(\/api\/[^/]+\/fs\/uploads\/read\?path=editor-files%2F[\w-]+\.txt\)$/,
      );

    // Reopen: that link parses back into a chip (not a bare link), and the X
    // removes it.
    await openTask(page, orgSlug, title);
    const reopened = page.getByRole("link", { name: `Download ${DOC_NAME}` });
    await expect(reopened).toBeVisible();

    await page.getByRole("button", { name: "Remove attachment" }).click();
    await expect(reopened).toHaveCount(0);

    await closeTask(page);
    await expect
      .poll(async () => {
        const { items } = await call<{ items: TaskBoardItem[] }>(
          "TASK_BOARD_ITEM_LIST",
          {},
        );
        return items.find((i) => i.id === item.id)?.description ?? null;
      })
      .toBe(null);
  });
});
