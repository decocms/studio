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

import type { APIRequestContext, Page } from "@playwright/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

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

/**
 * Focus the chat input and type via the keyboard.
 *
 * Tiptap is contenteditable, so `page.fill()` is unsupported — we have to
 * use real keystrokes. Once typing completes we explicitly wait until the
 * rendered text matches what we typed, so the caller can safely reload /
 * navigate immediately after this call without racing the editor's last
 * onUpdate (which is what persists the draft to sessionStorage).
 */
async function typeInComposer(page: Page, text: string): Promise<void> {
  const input = page.locator(CHAT_INPUT);
  await input.click();
  await page.keyboard.type(text);
  await expect(input).toHaveText(text, { timeout: 5_000 });
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

/**
 * Dismiss the bottom-right "Release announcement" popover if present.
 *
 * Fresh users get a one-time release popover (e.g. "Claude Opus 4.8 is the
 * new default") on first home-page render. It does NOT visually overlap the
 * chat input but it *does* sit on top of the send button's z-index when the
 * page is short enough — Playwright then sees the dialog intercept pointer
 * events on `.click()`. Closing it is the cleanest neutral fix; users would
 * either dismiss it or wait for it to fade. No-op if not present.
 */
async function dismissReleaseAnnouncement(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Release announcement" });
  if ((await dialog.count()) === 0) return;
  // The dialog has a close button — a single icon button inside the popover.
  // Fall back to pressing Escape if the close button isn't reachable.
  const closeButton = dialog.getByRole("button").first();
  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click();
  } else {
    await page.keyboard.press("Escape");
  }
  await dialog.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
}

/**
 * Submit the composer.
 *
 * We click the explicit send button rather than pressing Enter because the
 * one-time "Now Available" release announcement that appears on first
 * render can steal key events — leaving the keystroke unhandled and the
 * form unsubmitted. The button calls the same handler the Tiptap Enter
 * binding does, so the user-facing behavior under test (the
 * draft-clear-on-submit path) is identical either way.
 *
 * Title="Send message (Enter)" is set by ChatInput. The composer never
 * shows two enabled send buttons at once (home / per-thread composers are
 * mutually exclusive), so `.first()` keeps the locator safe across flows.
 */
async function submitComposer(page: Page): Promise<void> {
  // The release-announcement popover sometimes intercepts pointer events on
  // the send button, so dismiss it first if it's still visible.
  await dismissReleaseAnnouncement(page);
  await page
    .getByTitle("Send message (Enter)", { exact: true })
    .first()
    .click();
}

/** UUID v4 shape. Matches the output of `crypto.randomUUID()` used for task ids. */
const TASK_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Seed an AI provider key for the freshly-signed-up org so the home / thread
 * routes render the chat composer instead of `NoAiProviderEmptyState`.
 *
 * Fresh test users have no provider configured, so `useAiProviderKeys()`
 * returns an empty list and `HomePage` short-circuits to the
 * `NoAiProviderEmptyState` view — which doesn't mount the Tiptap input.
 *
 * The stored key is never actually exercised: these tests only verify draft
 * persistence in the editor, never a real chat completion.
 * `AI_PROVIDER_KEY_CREATE` just stores the value in the vault; it doesn't
 * validate the credential against the upstream provider.
 */
async function seedAiProviderKey(
  request: APIRequestContext,
  orgSlug: string,
): Promise<void> {
  await callSelfMcpTool(request, orgSlug, "AI_PROVIDER_KEY_CREATE", {
    providerId: "anthropic",
    label: "chat-input-draft-e2e",
    apiKey: "sk-ant-e2e-fake-key-do-not-use",
  });
}

/**
 * Re-navigate to the thread page without the `?autosend=` query string.
 *
 * After `openNewThread`, the URL is `/${orgSlug}/${taskId}?autosend=true...`
 * which puts the chat into a streaming state (autosend fires the seed
 * message). While streaming, the Tiptap editor is disabled, so typing a
 * draft would be a no-op. Navigating to the same task without the autosend
 * query lands on the page with the editor enabled — perfect for testing
 * draft persistence.
 */
async function gotoThreadIdle(
  page: Page,
  orgSlug: string,
  taskId: string,
): Promise<void> {
  await page.goto(`/${orgSlug}/${taskId}`);
  await waitForChatInput(page);
}

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

  // Seed an AI provider key before every test so the home / thread routes
  // render the composer instead of `NoAiProviderEmptyState`. Fresh test
  // users have no provider, so without this the chat input never mounts.
  //
  // Also pre-mark every known release as "seen" in localStorage so the
  // bottom-right `FloatingReleaseCard` (`useReleaseSeenState`) never
  // renders. The card intercepts pointer events on the send button on
  // viewports where they overlap, and the close-button dismiss path is
  // animation-racy. Pre-seeding kills the dialog at the source.
  //
  // If a release is added to `apps/mesh/src/web/lib/release-feed.ts`, add
  // its id here too — otherwise the next id (`RELEASES[0]`) will surface
  // as a popover and re-introduce the failure.
  test.beforeEach(async ({ authedPage }) => {
    const { page, orgSlug } = authedPage;
    await seedAiProviderKey(page.context().request, orgSlug);
    await page.addInitScript(() => {
      const STORAGE_KEY = "studio.release-feed.v1";
      const seenAt = "1970-01-01T00:00:00.000Z";
      const seen: Record<string, { seenAt: string }> = {
        "claude-opus-4-8": { seenAt },
        "enhanced-sidebar": { seenAt },
        "smarter-task-delegation": { seenAt },
        "sidebar-task-groups": { seenAt },
        "release-channel": { seenAt },
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(seen));
      } catch {
        // private mode / sandboxed storage — fall back to clicking dismiss.
      }
    });
  });

  test("thread draft survives page refresh", async ({ authedPage }) => {
    const { page, orgSlug } = authedPage;
    const taskId = await openNewThread(page, orgSlug, "kick off");

    // Land on the thread WITHOUT autosend so the editor isn't disabled by
    // streaming. The home-composer submit kicks off autosend which puts the
    // chat into a streaming state; the editor's disabled prop swallows our
    // typing if we don't shed the autosend query first.
    await gotoThreadIdle(page, orgSlug, taskId);
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

    // Land on the thread WITHOUT autosend so typing isn't swallowed by the
    // streaming-disabled editor. Then type a draft, submit, and verify the
    // saved draft was cleared by reloading and reading the editor.
    await gotoThreadIdle(page, orgSlug, taskId);
    await clearComposer(page);
    await typeInComposer(page, "this should be cleared after submit");
    await submitComposer(page);

    // Reload and confirm the input is empty (submit's clearChatDraft
    // wiped the per-thread draft from sessionStorage).
    await page.goto(`/${orgSlug}/${taskId}`);
    await waitForChatInput(page);
    expect(await composerText(page)).toBe("");
  });

  test("drafts are isolated per thread", async ({ authedPage }) => {
    const { page, orgSlug } = authedPage;
    const taskA = await openNewThread(page, orgSlug, "thread a");
    await gotoThreadIdle(page, orgSlug, taskA);
    await clearComposer(page);
    await typeInComposer(page, "draft for A");

    // Start a second thread via the home composer. Then land on it in idle
    // state so we can type without the streaming-disabled editor swallowing
    // input.
    const taskB = await openNewThread(page, orgSlug, "thread b");
    await gotoThreadIdle(page, orgSlug, taskB);
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
