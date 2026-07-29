/**
 * Desktop-split characterization — Phase 0 of the desktop-app migration
 * (the desktop migration contract, the desktop migration contract §0.4).
 *
 * Pins TODAY's rendered behavior of the UI surfaces the migration will split
 * apart behind `useIsDesktopApp()`:
 *
 *   1. RuntimeSwitcher (chat/pills/runtime-switcher.tsx) — the "Runtime: …"
 *      pill on an unlocked, sandbox-backed chat, and its dropdown's Cloud
 *      sandbox / This device rows (label, description, disabled hint, active
 *      state).
 *   2. TierTrigger (chat/tier-trigger.tsx) — the tier popover's cloud-only
 *      shape (no runtime segmented control) that the default e2e org (no
 *      desktop linked) exhibits.
 *
 * These are black-box UI assertions, not the lock-contract coverage already
 * owned by chat-locked-thread.spec.ts. Once the flag-off/flag-on split lands
 * in Phase 4, this file must stay byte-green with the flag off — that's the
 * whole point of characterizing it now.
 *
 * No app-source imports (see packages/e2e/README.md) — every expected string
 * below is inlined from reading the component source, not imported from it.
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
 * composer (and its pills) instead of `NoAiProviderEmptyState`. The key
 * value is never exercised — no message is ever sent in this file. Same
 * trick `chat-input-draft.spec.ts` / `chat-locked-thread.spec.ts` use.
 */
async function seedAiProviderKey(
  api: APIRequestContext,
  orgSlug: string,
): Promise<void> {
  await callSelfMcpTool(api, orgSlug, "AI_PROVIDER_KEY_CREATE", {
    providerId: "anthropic",
    label: "desktop-split-characterization-e2e",
    apiKey: "sk-ant-e2e-fake-key-do-not-use",
  });
}

/** Number of `<svg>` descendants — used to distinguish an "active" row (tier
 *  or runtime icon + a `Check` glyph) from an inactive one (icon only),
 *  since the check mark carries no text a `getByText` could key off. */
async function svgCount(locator: Locator): Promise<number> {
  return locator.locator("svg").count();
}

test.describe("desktop-split characterization", () => {
  test.setTimeout(120_000);
  test("TierTrigger: cloud-only popover shape (no runtime segmented control)", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    await seedAiProviderKey(api, orgSlug);

    // No sandboxed agent needed — TierTrigger's shape is a function of the
    // session's (link-online, pending-harness) prefs, not the agent. The
    // plain org home page (well-known Decopilot agent) is enough, and
    // avoids the sandbox-start noise `createSandboxAgentAndThread` triggers.
    await page.goto(`/${orgSlug}`);
    await waitForChatInput(page);

    const trigger = page.getByRole("button", { name: "Smart", exact: true });
    await expect(trigger).toBeVisible();
    await trigger.click();

    const menu = page.locator('[role="menu"]');
    await expect(menu).toBeVisible();

    // No desktop linked → `hasLocal` is false → `TierTrigger` renders
    // `header={undefined}` (see tier-trigger.tsx's `RuntimeToggle` gate) —
    // the Cloud/This device segmented control is entirely absent, and so is
    // any per-runtime group label ("Claude Code" / "Codex").
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
