/**
 * E2E happy-path test for the sidebar "My threads" Show more pager.
 *
 * The sidebar no longer nests threads under expandable per-agent groups — the
 * current user's threads render as a single flat "My threads" list with one
 * global "Show more" button (backed by the thread store's paged fetch).
 *
 * Scenario:
 *   1. Create a fresh user + org (via authedPage fixture).
 *   2. Seed a dedicated virtual MCP (agent) and 15 threads against it via the
 *      self MCP API — the store's initial page is 10, so the list overflows.
 *   3. Navigate to the org home page where the sidebar renders and open it.
 *   4. Assert ≤ 10 seeded rows are visible initially.
 *   5. Assert a "Show more" button (aria-label="Show more tasks") is present.
 *   6. Click "Show more" and assert the seeded row count grows to 15.
 *   7. Assert the "Show more" button is hidden once all threads are loaded.
 */

import { callSelfMcpTool, setOrgFlags } from "../fixtures/mcp-tools";
import { addSidebarPersonalAgentOrderInitScriptForSlug } from "../fixtures/sidebar-order";
import { expect, test } from "../fixtures/test";

test.describe("Sidebar My threads Show more", () => {
  test("shows 10 tasks initially and loads all 15 after clicking Show more", async ({
    authedPage,
  }) => {
    // Default Playwright budget is 30s, but this test does ~17 sequential
    // self-MCP HTTP calls (1 vmcp + 15 threads + 1 list) plus a full SPA
    // boot before the first assertion — on slow CI that easily exceeds 30s.
    test.setTimeout(120_000);
    const { page, user, orgSlug } = authedPage;
    const request = page.context().request;

    // -------------------------------------------------------------------------
    // 1. Create a dedicated virtual MCP to seed tasks against. Using a fresh
    //    agent isolates this test from any other threads in the org.
    // -------------------------------------------------------------------------
    const agentTitle = `ShowMoreAgent-${Date.now()}`;
    const vmcpResult = await callSelfMcpTool<{
      item: { id: string; title: string };
    }>(request, orgSlug, "COLLECTION_VIRTUAL_MCP_CREATE", {
      data: {
        title: agentTitle,
        description: "Agent seeded for sidebar show-more e2e test",
        connections: [],
      },
    });
    const agentId = vmcpResult.item.id;
    expect(agentId).toBeTruthy();

    // -------------------------------------------------------------------------
    // 2. Seed 15 threads against the new agent.
    //    The ThreadManagerStore's initial page is 10, so the list will show 10
    //    rows and a "Show more" button.
    // -------------------------------------------------------------------------
    const TOTAL_THREADS = 15;
    // Parallelize to keep setup well under the test budget on CI. Ordering in
    // the sidebar comes from `updated_at desc` on the server, not this loop.
    await Promise.all(
      Array.from({ length: TOTAL_THREADS }, (_, i) =>
        callSelfMcpTool(request, orgSlug, "COLLECTION_THREADS_CREATE", {
          data: {
            title: `Show-more test task ${i + 1}`,
            virtual_mcp_id: agentId,
          },
        }),
      ),
    );

    // -------------------------------------------------------------------------
    // 3. Navigate to the org home page — the sidebar loads here. Seeding the
    //    personal order isn't required for "My threads" (which lists all of the
    //    user's threads regardless of agent membership), but keeps the Agents
    //    section populated and mirrors real usage.
    // -------------------------------------------------------------------------
    await addSidebarPersonalAgentOrderInitScriptForSlug(
      page,
      orgSlug,
      user.userId,
      [agentId],
    );

    // This pager only exists in the classic sidebar.
    await setOrgFlags(request, orgSlug, { nav_v2: false });

    await page.goto(`/${orgSlug}`);
    // Wait until the org home content has settled (URL confirmed, shell rendered).
    await page.waitForURL(new RegExp(`/${orgSlug}(/|$)`), { timeout: 15_000 });

    // -------------------------------------------------------------------------
    // 4. Open the sidebar.
    //    Fresh users start with the sidebar collapsed (localStorage key
    //    `sidebar.open` defaults to false). Collapsed mode renders the agent
    //    rail rather than the flat "My threads" list, so toggle it open first.
    // -------------------------------------------------------------------------
    const toggleSidebar = page.getByRole("button", { name: "Toggle sidebar" });
    await toggleSidebar.waitFor({ state: "visible", timeout: 15_000 });
    await toggleSidebar.click();

    // -------------------------------------------------------------------------
    // 5. Assert ≤ 10 seeded rows initially visible.
    //    "My threads" is open by default and mixes agents, so scope the count
    //    to our seeded titles — that isolates the assertion from any unrelated
    //    thread (e.g. a decopilot welcome thread) in the fresh org.
    // -------------------------------------------------------------------------
    const seededRows = page
      .locator("[data-task-id]")
      .filter({ hasText: "Show-more test task" });
    await seededRows.first().waitFor({ state: "visible", timeout: 30_000 });

    const initialCount = await seededRows.count();
    expect(initialCount).toBeGreaterThanOrEqual(1);
    expect(initialCount).toBeLessThanOrEqual(10);

    // -------------------------------------------------------------------------
    // 6. Assert the "Show more" button is visible, then click it.
    // -------------------------------------------------------------------------
    const showMoreButton = page.getByRole("button", {
      name: "Show more tasks",
    });
    await expect(showMoreButton).toBeVisible({ timeout: 5_000 });

    await showMoreButton.click();

    // -------------------------------------------------------------------------
    // 7. All 15 seeded rows load, and the button disappears once the store has
    //    no more pages (total threads < 2 * PAGE_SIZE).
    // -------------------------------------------------------------------------
    await expect(seededRows).toHaveCount(TOTAL_THREADS, { timeout: 10_000 });
    await expect(showMoreButton).toBeHidden();

    // Verify the user info is consistent (guards against fixture wiring bugs).
    expect(user.orgSlug).toBe(orgSlug);
  });
});
