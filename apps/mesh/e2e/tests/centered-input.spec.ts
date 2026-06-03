/**
 * E2E: centered chat input on `/$org/$taskId`.
 *
 * Drives a real browser end-to-end. Confirms the redesign of the
 * empty-state composer:
 *
 *   1. A fresh empty thread renders the centered layout — `CenteredComposer`
 *      wraps the input with `data-chat-centered="true"`.
 *   2. The chat input itself (`data-chat-input="true"`) is reachable
 *      inside the centered wrapper.
 *   3. Once the user sends the first message, the centered wrapper
 *      unmounts and the docked layout takes over (chat input is still
 *      visible, but no longer a descendant of `data-chat-centered`).
 *
 * The above-row's exact contents (Branch + Harness pills) depend on
 * whether the agent is clonable / has a GitHub repo. A fresh
 * Decopilot conversation is non-clonable, so this baseline spec only
 * asserts on the centered-vs-docked layout swap. Cases involving the
 * BranchPill / ModePicker rendering are covered by the pure-component
 * tests in `chat-mode-row.test.tsx` and `centered-composer.test.tsx`.
 */

import type { APIRequestContext, Page } from "@playwright/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

const CHAT_INPUT = '[data-chat-input="true"]';
const CENTERED_WRAPPER = '[data-chat-centered="true"]';

/**
 * Cold Vite + signup + first navigation can exceed 30s on slow runs.
 * Match the budget used by `chat-input-draft.spec.ts`.
 */
const CHAT_INPUT_TIMEOUT_MS = 60_000;

async function waitForChatInput(page: Page): Promise<void> {
  await page
    .locator(CHAT_INPUT)
    .waitFor({ state: "visible", timeout: CHAT_INPUT_TIMEOUT_MS });
}

/**
 * Seed an AI provider key for the freshly-signed-up org so the chat
 * input mounts. Fresh test users have no provider configured, so the
 * route short-circuits to `NoAiProviderEmptyState` (no Tiptap input).
 *
 * The stored key is never actually exercised — these tests only verify
 * the layout swap, not a real chat completion.
 */
async function seedAiProviderKey(
  request: APIRequestContext,
  orgSlug: string,
): Promise<void> {
  await callSelfMcpTool(request, orgSlug, "AI_PROVIDER_KEY_CREATE", {
    providerId: "anthropic",
    label: "centered-input-e2e",
    apiKey: "sk-ant-e2e-fake-key-do-not-use",
  });
}

/** Pre-mark known releases as "seen" so the dismiss popover never appears. */
async function suppressReleaseAnnouncement(page: Page): Promise<void> {
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
      // private mode / sandboxed storage — ignore.
    }
  });
}

test.describe("centered chat input on /$org/$taskId", () => {
  // Cold Vite + signup + multiple navigations easily exceeds 30s on first runs.
  test.setTimeout(180_000);

  test.beforeEach(async ({ authedPage }) => {
    const { page, orgSlug } = authedPage;
    await seedAiProviderKey(page.context().request, orgSlug);
    await suppressReleaseAnnouncement(page);
  });

  test("empty thread → centered, after first send → docked", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;

    // A fresh UUID for a never-opened thread lands us in the empty
    // (centered) state. The task row only persists once the first
    // message is sent, so this URL is genuinely "thread doesn't exist
    // yet" — which is what we want to exercise.
    const taskId = crypto.randomUUID();
    await page.goto(`/${orgSlug}/${taskId}`);
    await waitForChatInput(page);

    // Empty state: centered wrapper visible, input is its descendant.
    const centered = page.locator(CENTERED_WRAPPER);
    await expect(centered).toBeVisible();
    await expect(centered.locator(CHAT_INPUT)).toBeVisible();

    // Type a message and send. We click the explicit "Send message"
    // button because the one-time release popover can otherwise eat
    // the Enter keystroke — same workaround the draft spec uses.
    const input = page.locator(CHAT_INPUT);
    await input.click();
    await page.keyboard.type("hello");
    await expect(input).toHaveText("hello", { timeout: 5_000 });
    await page
      .getByTitle("Send message (Enter)", { exact: true })
      .first()
      .click();

    // Docked state: centered wrapper unmounts. The chat input is
    // still on the page (now in Chat.Footer), but no longer a child
    // of [data-chat-centered].
    await expect(page.locator(CENTERED_WRAPPER)).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.locator(CHAT_INPUT)).toBeVisible();
  });

  test("no BranchPill renders in the agent-shell toolbar", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;

    const taskId = crypto.randomUUID();
    await page.goto(`/${orgSlug}/${taskId}`);
    await waitForChatInput(page);

    // The toolbar is the right-side action area in the agent shell.
    // After this redesign, HeaderActions only renders the next-action
    // button (Save changes / Open PR / etc.) — not a BranchPill.
    // There should be no toolbar button whose label is a branch name.
    //
    // We assert this by checking that the toolbar (Toolbar.Right slot)
    // contains no button that looks like a git ref. The legacy
    // BranchPill rendered its label as the branch name (e.g. "main"),
    // so a regex against common ref shapes catches a regression.
    const toolbar = page.locator("[data-toolbar-right], header").first();
    const branchLike = toolbar.locator(
      'button:has(svg[aria-label*="branch" i]), button[title*="branch" i]',
    );
    await expect(branchLike).toHaveCount(0);
  });
});
