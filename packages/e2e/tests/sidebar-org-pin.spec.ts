/**
 * E2E: org pin via sidebar agent group context menu (admin/owner user).
 */

import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { addSidebarPersonalAgentOrderInitScriptForSlug } from "../fixtures/sidebar-order";
import { expect, test } from "../fixtures/test";

test.describe("Sidebar org pin", () => {
  test("owner can pin an agent for all members from the context menu", async ({
    authedPage,
  }) => {
    test.setTimeout(120_000);
    const { page, orgSlug, user } = authedPage;
    const request = page.context().request;

    const agentTitle = `OrgPinAgent-${Date.now()}`;
    const vmcpResult = await callSelfMcpTool<{
      item: { id: string; title: string; pinned?: boolean };
    }>(request, orgSlug, "COLLECTION_VIRTUAL_MCP_CREATE", {
      data: {
        title: agentTitle,
        description: "Agent for org pin e2e",
        connections: [],
      },
    });
    const agentId = vmcpResult.item.id;
    expect(agentId).toBeTruthy();

    await callSelfMcpTool(request, orgSlug, "COLLECTION_THREADS_CREATE", {
      data: {
        title: "Task for org pin agent",
        virtual_mcp_id: agentId,
      },
    });

    // Sidebar membership is explicit — seed personal order so the group is
    // visible before the test org-pins it from the context menu.
    await addSidebarPersonalAgentOrderInitScriptForSlug(
      page,
      orgSlug,
      user.userId,
      [agentId],
    );

    await page.goto(`/${orgSlug}`);
    await page.waitForURL(new RegExp(`/${orgSlug}(/|$)`), { timeout: 15_000 });

    const toggleSidebar = page.getByRole("button", { name: "Toggle sidebar" });
    await toggleSidebar.waitFor({ state: "visible", timeout: 15_000 });
    await toggleSidebar.click();

    const anyGroupHeader = page.locator('[role="button"][aria-expanded]');
    await anyGroupHeader.first().waitFor({ state: "visible", timeout: 30_000 });

    const groupHeader = anyGroupHeader.filter({ hasText: agentTitle }).first();
    await groupHeader.waitFor({ state: "visible", timeout: 30_000 });

    const pinMenuItem = page.getByRole("menuitem", {
      name: "Pin for all members",
    });

    // Role resolution is async (`useCanPinAgentsForOrg`); retry opening the menu
    // until the pin action is available for the owner.
    await expect(async () => {
      await page.keyboard.press("Escape");
      await groupHeader.click({ button: "right" });
      await expect(pinMenuItem).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    await pinMenuItem.click();

    await expect
      .poll(async () => {
        const got = await callSelfMcpTool<{
          item: { id: string; pinned?: boolean } | null;
        }>(request, orgSlug, "COLLECTION_VIRTUAL_MCP_GET", { id: agentId });
        return got.item?.pinned === true;
      })
      .toBe(true);
  });
});
