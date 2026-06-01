/**
 * E2E: chat input draft persistence to sessionStorage.
 *
 * Drives the real browser end-to-end. Confirms:
 *   1. Thread drafts survive page refresh.
 *   2. Home composer drafts survive page refresh.
 *   3. Successful submit clears the draft.
 *   4. Drafts are isolated per thread.
 *
 * The quota-exceeded path is deliberately NOT exercised here — it's
 * covered by unit tests on the chat-draft helper. PostHog telemetry will
 * surface real-world occurrence in production.
 */

import { expect, test } from "../fixtures/test";
import type { Page } from "@playwright/test";

const CHAT_INPUT = '[data-chat-input="true"]';
/**
 * Cold-Vite first paint on a fresh sandbox can take 20-40s on slow hardware
 * (full SPA compile + auth bootstrap). Use a generous wait for the very first
 * chat-input appearance per page navigation; subsequent appearances after
 * page.reload() are much faster.
 */
const CHAT_INPUT_TIMEOUT_MS = 60_000;

/** Wait for the chat input to be visible — generous timeout for cold Vite + auth bootstrap. */
async function waitForChatInput(page: Page): Promise<void> {
  await page
    .locator(CHAT_INPUT)
    .waitFor({ state: "visible", timeout: CHAT_INPUT_TIMEOUT_MS });
}

/** Focus the chat input and type via the keyboard. Tiptap is contenteditable, so we cannot use `fill`. */
async function typeInComposer(page: Page, text: string): Promise<void> {
  const input = page.locator(CHAT_INPUT);
  await input.click();
  await page.keyboard.type(text);
}

/** Read the visible text content of the chat input. */
async function composerText(page: Page): Promise<string> {
  return (await page.locator(CHAT_INPUT).innerText()).trim();
}

/** Clear the chat input by selecting all and deleting. */
async function clearComposer(page: Page): Promise<void> {
  await page.locator(CHAT_INPUT).click();
  // ControlOrMeta is Playwright's portable select-all modifier — picks the
  // right key for the browser-emulated OS, not the runner's host OS.
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
}

/** Submit by pressing Enter (no Shift). */
async function submitComposer(page: Page): Promise<void> {
  await page.locator(CHAT_INPUT).click();
  await page.keyboard.press("Enter");
}

/** UUID v4 shape. Matches the output of `crypto.randomUUID()` used for task ids. */
const TASK_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Type a message in the home composer, submit, and wait until URL contains a taskId. Returns the taskId. */
async function openNewThread(
  page: Page,
  orgSlug: string,
  seed: string,
): Promise<string> {
  await page.goto(`/${orgSlug}`);
  await waitForChatInput(page);
  await typeInComposer(page, seed);
  await submitComposer(page);
  // After submit, the URL becomes /<orgSlug>/<taskId> via homeSubmit's
  // navigate() call. Wait until the first path segment after the org slug
  // looks like a UUID (the task id) — avoids matching sub-routes like
  // /<orgSlug>/settings.
  await page.waitForURL(
    (url) => {
      const segments = new URL(url).pathname.split("/").filter(Boolean);
      return (
        segments[0] === orgSlug &&
        !!segments[1] &&
        TASK_ID_REGEX.test(segments[1])
      );
    },
    { timeout: 20_000 },
  );
  const match = new URL(page.url()).pathname.match(
    new RegExp(`^/${orgSlug}/([^/]+)`),
  );
  if (!match || !match[1] || !TASK_ID_REGEX.test(match[1])) {
    throw new Error(`could not extract taskId from ${page.url()}`);
  }
  return match[1];
}

test.describe("chat input draft persistence", () => {
  // Cold Vite + signUp + multiple navigations easily exceeds the 30s default
  // on slow CI / first runs. Match the budget used by sidebar-show-more.
  test.setTimeout(180_000);

  test("thread draft survives page refresh", async ({ authedPage }) => {
    const { page, orgSlug } = authedPage;
    await openNewThread(page, orgSlug, "kick off");

    await waitForChatInput(page);
    await clearComposer(page);
    await typeInComposer(page, "draft message that should survive");

    await page.reload();

    await waitForChatInput(page);
    expect(await composerText(page)).toBe("draft message that should survive");
  });

  test("home composer draft survives page refresh", async ({ authedPage }) => {
    const { page, orgSlug } = authedPage;
    await page.goto(`/${orgSlug}`);
    await waitForChatInput(page);

    await typeInComposer(page, "home composer draft");

    await page.reload();

    await waitForChatInput(page);
    expect(await composerText(page)).toBe("home composer draft");
  });

  test("submit clears the draft", async ({ authedPage }) => {
    const { page, orgSlug } = authedPage;
    const taskId = await openNewThread(page, orgSlug, "first");

    // Type a second message and submit it (clearing should fire).
    await waitForChatInput(page);
    await clearComposer(page);
    await typeInComposer(page, "this should be cleared after submit");
    await submitComposer(page);

    // Reload and confirm the input is empty.
    await page.goto(`/${orgSlug}/${taskId}`);
    await waitForChatInput(page);
    expect(await composerText(page)).toBe("");
  });

  test("drafts are isolated per thread", async ({ authedPage }) => {
    const { page, orgSlug } = authedPage;
    const taskA = await openNewThread(page, orgSlug, "thread a");
    await waitForChatInput(page);
    await clearComposer(page);
    await typeInComposer(page, "draft for A");

    // Navigate to the home composer to start a second thread.
    const taskB = await openNewThread(page, orgSlug, "thread b");
    await waitForChatInput(page);
    await clearComposer(page);
    await typeInComposer(page, "draft for B");

    // Switch back to A: A's draft should still be there.
    await page.goto(`/${orgSlug}/${taskA}`);
    await waitForChatInput(page);
    expect(await composerText(page)).toBe("draft for A");

    // Switch to B: B's draft should still be there.
    await page.goto(`/${orgSlug}/${taskB}`);
    await waitForChatInput(page);
    expect(await composerText(page)).toBe("draft for B");
  });
});
