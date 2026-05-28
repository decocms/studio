/**
 * Page Editor browser leg of the feature harness.
 *
 * The data-path contract (Studio Pack install, MCP tool sequence,
 * storage state, multi-tenant isolation, export bundle) lives in
 * features/page-editor/happy-path.test.ts. This spec is the
 * browser-visible half: it sits between Better Auth signup and the
 * user actually seeing the iframe with the right contract wired in.
 *
 * What it proves:
 *   - Fresh signup auto-installs the Studio Pack, including the Page
 *     Editor agent.
 *   - The Page Editor agent surfaces in the org's agents-list UI.
 *   - Clicking it opens a chat with the Page-Preview tab routed
 *     automatically — i.e. the `defaultMainView: { type: "page-preview" }`
 *     metadata threads end-to-end into the panel-tab resolver.
 *   - The iframe at `/api/<org>/page-preview/host` loads and runs its
 *     preact bootstrap (the welcome quiz mounts).
 *
 * Run: `PW=1 bun run features:test page-editor`
 *       (the harness CLI shells out to playwright when PW=1)
 *
 * Or directly via Playwright:
 *   bun run --cwd=apps/mesh exec playwright test \
 *     e2e/tests/features/page-editor.browser.spec.ts
 *
 * If this spec breaks, follow the Loop in features/page-editor/feature.md
 * before patching. The browser leg is part of the contract; don't
 * loosen the test to make a green build.
 */

import { expect, test } from "@playwright/test";
import { signUp } from "../../fixtures/auth";

// Studio Pack installation runs via a DBOS workflow on org.afterCreate.
// It's idempotent and fast (<1s in practice) but async — so the agent
// may not appear in the agents list on the first navigation. Polling
// the list with a generous timeout absorbs that race.
const STUDIO_PACK_INSTALL_TIMEOUT = 30_000;

test.describe("Page Editor — browser leg", () => {
  test("Studio Pack installs the agent and the preview iframe boots", async ({
    page,
  }) => {
    // 1. Fresh user + auto-created org. signUp lands somewhere under
    // /<orgSlug>/...; agents-section route is reliable.
    await signUp(page);
    await page.waitForURL(
      (url) => {
        const slug = url.pathname.split("/")[1];
        return !!slug && slug !== "login" && slug !== "api";
      },
      { timeout: 15_000 },
    );
    const orgSlug = new URL(page.url()).pathname.split("/")[1]!;

    // 2. Navigate to the agents list — Studio Pack agents (including
    // Page Editor) live alongside any user-created ones.
    await page.goto(`/${orgSlug}/agents`);

    // 3. Wait for Page Editor to appear. The DBOS install workflow
    // races signup; refreshing once after a brief delay catches the
    // case where the page rendered the agents list before the install
    // finished.
    const pageEditorCard = page
      .locator('[data-testid="project-card"]')
      .filter({ hasText: "Page Editor" })
      .or(page.getByRole("link", { name: /Page Editor/i }))
      .or(page.getByRole("button", { name: /Page Editor/i }))
      .first();

    await expect(pageEditorCard).toBeVisible({
      timeout: STUDIO_PACK_INSTALL_TIMEOUT,
    });

    // 4. Click into the Page Editor agent. The card navigates to
    // /<orgSlug>/<taskId>?virtualmcpid=studio-page-editor_<orgId>.
    await pageEditorCard.click();
    await page.waitForURL(/[?&]virtualmcpid=studio-page-editor_/, {
      timeout: 15_000,
    });

    // 5. The page-preview tab must be the default main view. We don't
    // pin to the tab DOM (it can vary across UI revisions); we pin to
    // the iframe it owns — that's the only thing that has to exist
    // exactly as named for the feature to work.
    const previewIframe = page.frameLocator('iframe[title="Page preview"]');

    // 6. The iframe is mounted and pointing at the host route. Wait
    // for ANY element inside — the welcome quiz root, the empty stage,
    // anything that proves the preact bundle executed. Catch most boot
    // failures (network, syntax errors in host-html.ts, CSP block).
    await expect(previewIframe.locator("body")).toBeVisible({
      timeout: 20_000,
    });

    // 7. The host runtime renders the welcome quiz on first load (no
    // active page yet). It shows the "Build a beautiful page" headline
    // or similar marketing copy; pin to one stable string from the
    // welcome template. If you renamed the welcome quiz, update both
    // the template AND this assertion.
    const welcomeHeadline = previewIframe
      .locator("body")
      .getByText(/build|create|start|page/i)
      .first();
    await expect(welcomeHeadline).toBeVisible({ timeout: 20_000 });
  });
});
