/**
 * Black-box contract for the hosted Decopilot tier selector. Studio web has a
 * single hosted runtime, so the popover presents model tiers directly without
 * a runtime selector or local coding-harness choices.
 *
 * No app-source imports (see packages/e2e/README.md): expected wire and UI
 * values are owned by this contract.
 */

import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

const CHAT_INPUT = '[data-chat-input="true"]';
// Cold Vite + DB + auth bootstrap can take a while on the first paint of a
// freshly signed-up session — see chat-input-draft.spec.ts for the same
// budget rationale.
const CHAT_INPUT_TIMEOUT_MS = 60_000;

async function waitForChatInput(page: Page): Promise<void> {
  await page
    .locator(CHAT_INPUT)
    .waitFor({ state: "visible", timeout: CHAT_INPUT_TIMEOUT_MS });
}

/**
 * Seed an AI provider key so the thread/home route renders the real chat
 * composer (and its pills) instead of `NoAiProviderEmptyState`. Its catalog
 * points at the suite's local HTTP fixture, which returns no models; no real
 * vendor or generation endpoint is exercised.
 */
async function seedAiProviderKey(
  api: APIRequestContext,
  orgSlug: string,
): Promise<void> {
  const mockPort = process.env.COMMERCE_MOCK_PORT ?? "4100";
  await callSelfMcpTool(api, orgSlug, "AI_PROVIDER_KEY_CREATE", {
    providerId: "openai-compatible",
    label: "hosted-tier-selector-e2e",
    apiKey: JSON.stringify({
      baseUrl: `http://localhost:${mockPort}/v1`,
      apiKey: "e2e-local-model-catalog",
    }),
  });
}

/** Number of `<svg>` descendants — used to distinguish an "active" row (tier
 *  or runtime icon + a `Check` glyph) from an inactive one (icon only),
 *  since the check mark carries no text a `getByText` could key off. */
async function svgCount(locator: Locator): Promise<number> {
  return locator.locator("svg").count();
}

test.describe("hosted tier selector", () => {
  test.setTimeout(120_000);
  test("shows hosted model tiers without a runtime selector", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    await seedAiProviderKey(api, orgSlug);

    // The well-known Decopilot agent on the org home page is sufficient; no
    // sandbox needs to start to prove the selector's hosted-only shape.
    await page.goto(`/${orgSlug}`);
    await waitForChatInput(page);

    const trigger = page.getByRole("button", { name: "Smart", exact: true });
    await expect(trigger).toBeVisible();
    await trigger.click();

    const menu = page.locator('[role="menu"]');
    await expect(menu).toBeVisible();

    // A runtime segmented control and local coding-harness labels do not
    // belong to the hosted web contract.
    await expect(menu.getByText("This device", { exact: true })).toHaveCount(0);
    await expect(menu.getByText("Claude Code", { exact: true })).toHaveCount(0);
    await expect(menu.getByText("Codex", { exact: true })).toHaveCount(0);

    // A single ungrouped list of the three cloud tiers, with the
    // non-technical intent copy from `CLOUD_TIER_DESCRIPTIONS`.
    const fastRow = menu.getByRole("menuitem", { name: "Fast" });
    const smartRow = menu.getByRole("menuitem", { name: "Smart" });
    const thinkingRow = menu.getByRole("menuitem", { name: "Thinking" });
    await expect(fastRow).toBeVisible();
    await expect(smartRow).toBeVisible();
    await expect(thinkingRow).toBeVisible();

    await expect(
      fastRow.getByText("Quicker responses", { exact: true }),
    ).toBeVisible();
    await expect(
      smartRow.getByText("Balanced quality", { exact: true }),
    ).toBeVisible();
    await expect(
      thinkingRow.getByText("Deeper reasoning", { exact: true }),
    ).toBeVisible();

    // "Smart" is the default tier (`useChatPrefs().simpleModeTier`) — its
    // row carries the extra active `Check` glyph the other two don't.
    expect(await svgCount(fastRow)).toBe(1);
    expect(await svgCount(smartRow)).toBe(2);
    expect(await svgCount(thinkingRow)).toBe(1);
  });
});
