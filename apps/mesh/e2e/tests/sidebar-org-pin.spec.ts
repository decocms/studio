/**
 * E2E: org pin via sidebar agent group context menu (admin/owner user).
 */

import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

test.describe("Sidebar org pin", () => {
  test("owner can pin an agent for all members from the context menu", async ({
    authedPage,
  }) => {
    test.setTimeout(120_000);
    const { page, orgSlug } = authedPage;
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

    await callSelfMcpTool(request, orgSlug, "COLLECTION_THREADS_CREATE", {
      data: {
        title: "Task for org pin agent",
        virtual_mcp_id: agentId,
      },
    });

    await page.goto(`/${orgSlug}`);
    await page.waitForURL(new RegExp(`/${orgSlug}(/|$)`), { timeout: 15_000 });

    const sidebarToggle = page
      .getByRole("button", { name: /sidebar/i })
      .first();
    if (await sidebarToggle.isVisible()) {
      await sidebarToggle.click();
    }

    const groupHeader = page.getByRole("button", {
      name: new RegExp(agentTitle, "i"),
    });
    await expect(groupHeader).toBeVisible({ timeout: 15_000 });
    await groupHeader.click({ button: "right" });

    await page.getByRole("menuitem", { name: "Pin for all members" }).click();

    await expect
      .poll(async () => {
        const listed = await callSelfMcpTool<{
          items: Array<{ id: string; pinned?: boolean }>;
        }>(request, orgSlug, "COLLECTION_VIRTUAL_MCP_LIST", {
          where: { id: agentId },
        });
        return listed.items[0]?.pinned === true;
      })
      .toBe(true);
  });
});
