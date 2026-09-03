/**
 * E2E: a render error in one main-panel tab no longer bricks the panel.
 * Switching routes remounts the route-owned ErrorBoundary (keyed on the
 * active route tab) so the new route renders normally. The Site Editor's
 * sandbox drawer stays interactive throughout — it's a sibling of the
 * boundary.
 *
 * Trigger: dev-only `window.__forceTabError = <activeTab>` hook in
 * apps/web/src/layouts/main-panel-test-error-trigger.tsx.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";

test.describe("tab error boundary recovers on tab switch", () => {
  test.describe.configure({ timeout: 120_000 });

  // Helper: create a clonable agent + thread + return their ids. Mirrors the
  // setup used in sandbox-drawer-site-editor.spec.ts so the drawer assertion
  // in scenario B is meaningful (agentHasClonableSource must be true).
  async function setup({ page, orgSlug }: { page: Page; orgSlug: string }) {
    const api = page.context().request;
    const conn = await createHttpConnection(api, orgSlug, {
      title: "github-placeholder",
      url: "http://127.0.0.1:1/unused",
    });
    const agent = await callSelfMcpTool<{ item: { id: string } }>(
      api,
      orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      {
        data: {
          title: "error-boundary e2e",
          description: "cloneable",
          status: "active",
          pinned: false,
          connections: [{ connection_id: conn.id }],
          metadata: {
            githubRepo: {
              url: "https://github.com/example/repo",
              owner: "example",
              name: "repo",
              connectionId: conn.id,
            },
          },
        },
      },
    );
    const thread = await callSelfMcpTool<{ item: { id: string } }>(
      api,
      orgSlug,
      "COLLECTION_THREADS_CREATE",
      { data: { virtual_mcp_id: agent.item.id } },
    );
    return { agentId: agent.item.id, threadId: thread.item.id };
  }

  test("error in one tab unblocks after switching to another tab", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const { agentId, threadId } = await setup({ page, orgSlug });

    // Force the settings tab to throw on render. addInitScript runs before
    // any script on every navigation in the page's context, so the hook
    // survives the page.goto()s below.
    await page.addInitScript(() => {
      (window as unknown as { __forceTabError?: string }).__forceTabError =
        "settings";
    });

    await page.goto(
      `/${orgSlug}/${threadId}?virtualmcpid=${agentId}&main=settings`,
    );

    // Error boundary fallback is visible — matches the default fallback text
    // in apps/web/src/components/error-boundary.tsx.
    const routeError = page
      .getByTestId("main-panel")
      .getByText(/something went wrong/i);
    await expect(routeError).toBeVisible({
      timeout: 60_000,
    });

    // Use the real in-app navigation controls: a second document load would
    // remount every boundary and could pass without exercising route-keyed
    // recovery at all.
    const sidebar = page.locator('[data-slot="sidebar"]');
    await sidebar
      .getByRole("button", { name: "Site Editor", exact: true })
      .click({ timeout: 60_000 });
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${agentId}/site-editor` &&
        url.searchParams.get("virtualmcpid") === null &&
        url.searchParams.get("main") === null,
      { timeout: 60_000 },
    );
    await expect(routeError).toBeHidden();

    // Switch back through the same mounted shell. Settings throws again, which
    // proves the boundary reset follows the active route in both directions.
    await sidebar
      .getByRole("button", { name: "Settings", exact: true })
      .click({ timeout: 60_000 });
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${agentId}/settings` &&
        url.searchParams.get("thread") === threadId,
      { timeout: 60_000 },
    );
    await expect(routeError).toBeVisible({
      timeout: 60_000,
    });
  });

  test("sandbox drawer stays interactive while a tab body shows the error", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const { agentId, threadId } = await setup({ page, orgSlug });

    /** The Site Editor is the one tab the drawer renders under, so it is the
     *  only one whose crash can prove the drawer outlives a dead tab body. */
    await page.addInitScript(() => {
      (window as unknown as { __forceTabError?: string }).__forceTabError =
        "site-editor";
    });

    await page.goto(
      `/${orgSlug}/${threadId}?virtualmcpid=${agentId}&main=preview`,
    );

    // Error UI is visible inside the boundary.
    await expect(
      page.getByTestId("main-panel").getByText(/something went wrong/i),
    ).toBeVisible({
      timeout: 60_000,
    });

    // Sandbox drawer's setup button is a sibling of the boundary, so it
    // stays mounted and interactive — the drawer chrome should still render
    // even though the tab body crashed.
    const sandboxToolbarTab = page
      .getByTestId("main-panel")
      .getByRole("button", { name: /^sandbox$/i });
    await expect(sandboxToolbarTab).toBeVisible({ timeout: 60_000 });
  });
});
