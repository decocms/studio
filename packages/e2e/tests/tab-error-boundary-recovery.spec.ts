/**
 * E2E: a render error in one main-panel tab no longer bricks the panel.
 * Switching tabs remounts the ErrorBoundary (keyed on activeTab inside
 * MainPanelContent) so the new tab renders normally. The sandbox drawer
 * stays interactive throughout — it's a sibling of the boundary.
 *
 * See spec at docs/superpowers/specs/2026-06-03-sandbox-drawer-everywhere-design.md.
 *
 * Trigger: dev-only `window.__forceTabError = <activeTab>` hook in
 * apps/mesh/src/web/layouts/main-panel-tabs/index.tsx's TabBody.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";

test.describe("tab error boundary recovers on tab switch", () => {
  // Helper: create a clonable agent + thread + return their ids. Mirrors the
  // setup used in sandbox-drawer-everywhere.spec.ts so the drawer assertion
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
    // in apps/mesh/src/web/components/error-boundary.tsx.
    await expect(page.getByText(/something went wrong/i)).toBeVisible({
      timeout: 15_000,
    });

    // Switch to the preview tab — renders cleanly, no leftover error.
    await page.goto(
      `/${orgSlug}/${threadId}?virtualmcpid=${agentId}&main=preview`,
    );
    await expect(page.getByText(/something went wrong/i)).toBeHidden();

    // Switch back to settings — error UI reappears (state was reset on
    // remount via key={activeTab}, not memoized as healthy).
    await page.goto(
      `/${orgSlug}/${threadId}?virtualmcpid=${agentId}&main=settings`,
    );
    await expect(page.getByText(/something went wrong/i)).toBeVisible({
      timeout: 15_000,
    });
  });

  test("sandbox drawer stays interactive while a tab body shows the error", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const { agentId, threadId } = await setup({ page, orgSlug });

    await page.addInitScript(() => {
      (window as unknown as { __forceTabError?: string }).__forceTabError =
        "settings";
    });

    await page.goto(
      `/${orgSlug}/${threadId}?virtualmcpid=${agentId}&main=settings`,
    );

    // Error UI is visible inside the boundary.
    await expect(page.getByText(/something went wrong/i)).toBeVisible({
      timeout: 15_000,
    });

    // Sandbox drawer's setup button is a sibling of the boundary, so it
    // stays mounted and interactive — the drawer chrome should still render
    // even though the tab body crashed.
    const sandboxToolbarTab = page.getByRole("button", { name: /^sandbox$/i });
    await expect(sandboxToolbarTab).toBeVisible({ timeout: 15_000 });
  });
});
