/**
 * E2E: an app opened full screen keeps its chat open, and stays mounted, when
 * the chat starts a thread.
 *
 * Under project-first navigation a project app (Automations here) takes over
 * the main panel and its chat starts closed. Opening the chat and sending the
 * first message mints a thread; so does "New chat". Both change the thread
 * the session renders, and every thread-scoped provider above the layout used
 * to be keyed by it, so either one remounted the layout: the chat closed and
 * the app reloaded.
 *
 * The AI provider key is fake. The send still mints the thread, which is the
 * transition under test; the reply failing is irrelevant here.
 */

import type { Page } from "@playwright/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

const CHAT_INPUT = '[data-chat-input="true"]';
const CHAT_PANEL = '[data-testid="chat-panel"]';
const MAIN_PANEL = '[data-testid="main-panel"]';
const BOOT_TIMEOUT_MS = 60_000;

async function openChat(page: Page): Promise<void> {
  const input = page.locator(CHAT_INPUT);
  const toggle = page.getByRole("button", { name: "Open chat" }).first();
  await expect(async () => {
    if (!(await input.isVisible())) await toggle.click();
    await expect(input).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

async function send(page: Page, text: string): Promise<void> {
  await page.locator(CHAT_INPUT).click();
  await page.keyboard.type(text, { delay: 10 });
  await expect(page.locator(CHAT_INPUT)).toContainText(text);
  await page.locator(`${CHAT_PANEL} form button[type="submit"]`).click();
}

/** Remembers the main panel's DOM node; a remount replaces it. */
async function markMainPanel(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    (window as unknown as { __mainPanel?: Element | null }).__mainPanel =
      document.querySelector(selector);
  }, MAIN_PANEL);
}

async function mainPanelSurvived(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      (window as unknown as { __mainPanel?: Element | null }).__mainPanel
        ?.isConnected === true,
  );
}

function threadParam(page: Page): string | null {
  return new URL(page.url()).searchParams.get("thread");
}

test.describe("app takeover chat", () => {
  test.use({ projectFirstNav: true });
  test.describe.configure({ timeout: 180_000 });

  test("starting and switching threads keeps the chat open and the app mounted", async ({
    authedPage: { page, orgSlug },
  }) => {
    const request = page.context().request;
    await callSelfMcpTool(request, orgSlug, "AI_PROVIDER_KEY_CREATE", {
      providerId: "anthropic",
      label: "takeover-chat-e2e",
      apiKey: "sk-ant-e2e-fake-key-do-not-use",
    });
    const project = await callSelfMcpTool<{ item: { id: string } }>(
      request,
      orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      {
        data: {
          title: `Takeover ${Date.now()}`,
          status: "active",
          connections: [],
        },
      },
    );

    await page.goto(`/${orgSlug}/projects/${project.item.id}/automations`);
    await expect(page.locator(MAIN_PANEL)).toBeVisible({
      timeout: BOOT_TIMEOUT_MS,
    });
    expect(threadParam(page)).toBeNull();

    await openChat(page);
    await markMainPanel(page);

    // The first send from the empty composer mints the thread.
    await send(page, "first message");
    await expect.poll(() => threadParam(page)).not.toBeNull();
    const first = threadParam(page);
    await expect(page).toHaveURL(/\/automations\?/);
    await expect(page.locator(CHAT_PANEL)).toContainText("first message");
    expect(await mainPanelSurvived(page)).toBe(true);

    // "New chat" swaps the thread beside the same app.
    await page
      .locator('[data-testid="side-panel"] button[aria-label="New chat"]')
      .click();
    await expect.poll(() => threadParam(page)).not.toBe(first);
    await expect(page.locator(CHAT_INPUT)).toBeVisible();
    expect(await mainPanelSurvived(page)).toBe(true);

    await send(page, "second message");
    await expect(page.locator(CHAT_PANEL)).toContainText("second message");
    await expect(page.locator(CHAT_PANEL)).not.toContainText("first message");
    expect(await mainPanelSurvived(page)).toBe(true);
  });
});
