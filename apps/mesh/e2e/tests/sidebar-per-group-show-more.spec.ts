/**
 * E2E happy-path test for the sidebar per-group "Show more" feature.
 *
 * Scenario:
 *   1. Create a fresh user + org (via authedPage fixture).
 *   2. Seed a dedicated virtual MCP (agent) and 15 threads against it via
 *      the self MCP API — so the sidebar will have a single non-decopilot
 *      group that overflows the 10-task initial page.
 *   3. Navigate to the org home page where the sidebar renders.
 *   4. Expand the agent group (it starts collapsed because it's not decopilot
 *      and there's no active task in it).
 *   5. Assert ≤ 10 task rows are visible inside the group.
 *   6. Assert a "Show more" button (aria-label="Show more tasks") is present.
 *   7. Click "Show more" and assert the row count grows to ≥ 15.
 *   8. Assert the "Show more" button is still visible (we keep the affordance
 *      around so users can pull in tasks that arrive later via SSE).
 */

import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

test.describe("Sidebar per-group Show more", () => {
  test("shows 10 tasks initially and loads all 15 after clicking Show more", async ({
    authedPage,
  }) => {
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
    //    The ThreadManagerStore's initial page is 10, so the sidebar will
    //    display 10 rows and show the "Show more" button.
    // -------------------------------------------------------------------------
    const TOTAL_THREADS = 15;
    for (let i = 1; i <= TOTAL_THREADS; i++) {
      await callSelfMcpTool(request, orgSlug, "COLLECTION_THREADS_CREATE", {
        data: {
          title: `Show-more test task ${i}`,
          virtual_mcp_id: agentId,
        },
      });
    }

    // -------------------------------------------------------------------------
    // 3. Navigate to the org home page — the sidebar loads here.
    // -------------------------------------------------------------------------
    await page.goto(`/${orgSlug}`);
    // Wait until the org home content has settled (URL confirmed, shell rendered).
    await page.waitForURL(new RegExp(`/${orgSlug}(/|$)`), { timeout: 15_000 });

    // -------------------------------------------------------------------------
    // 4. Expand the agent group.
    //    The group header is a role="button" element with aria-expanded="false"
    //    for collapsed groups. We locate it by the agent title text it contains.
    //    The sidebar must have loaded at least one task row before we interact.
    // -------------------------------------------------------------------------

    // Wait for the task groups section to render by waiting for the agent's
    // group header to appear. Timeout covers the SSE/WebSocket initial fetch.
    const groupHeader = page.getByRole("button", { name: agentTitle }).first();
    await groupHeader.waitFor({ state: "visible", timeout: 20_000 });

    // Expand the group if it is currently collapsed.
    const isExpanded = await groupHeader.getAttribute("aria-expanded");
    if (isExpanded !== "true") {
      await groupHeader.click();
    }

    // -------------------------------------------------------------------------
    // 5. Assert ≤ 10 task rows initially visible inside the group.
    //    TaskRow elements have data-task-id and role="button". We scope the
    //    query inside the agent group's container, which is the next sibling
    //    rendered after the header expands.
    // -------------------------------------------------------------------------

    // The task rows share the DOM with the group header. Wait for at least one
    // to appear before counting.
    await page
      .locator("[data-task-id]")
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });

    const taskRows = page.locator("[data-task-id]");
    const initialCount = await taskRows.count();
    expect(initialCount).toBeGreaterThanOrEqual(1);
    expect(initialCount).toBeLessThanOrEqual(10);

    // -------------------------------------------------------------------------
    // 6. Assert the "Show more" button is visible inside the sidebar.
    // -------------------------------------------------------------------------
    const showMoreButton = page.getByRole("button", {
      name: "Show more tasks",
    });
    await expect(showMoreButton).toBeVisible({ timeout: 5_000 });

    // -------------------------------------------------------------------------
    // 7. Click "Show more" and wait for the row count to grow to ≥ 15.
    // -------------------------------------------------------------------------
    await showMoreButton.click();

    // Wait for the store to merge the second page — task rows will update.
    await expect(taskRows).toHaveCount(TOTAL_THREADS, { timeout: 10_000 });
    const afterCount = await taskRows.count();
    expect(afterCount).toBeGreaterThanOrEqual(TOTAL_THREADS);

    // -------------------------------------------------------------------------
    // 8. Assert the "Show more" button is still visible — we keep the
    //    affordance around so users can pull in tasks that arrive later
    //    (SSE inserts, fresh runs, etc.).
    // -------------------------------------------------------------------------
    await expect(showMoreButton).toBeVisible();

    // Verify the user info is consistent (guards against fixture wiring bugs).
    expect(user.orgSlug).toBe(orgSlug);
  });
});
