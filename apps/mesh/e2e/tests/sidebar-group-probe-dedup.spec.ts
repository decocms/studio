/**
 * E2E guard for sidebar per-group probe deduplication.
 *
 * When several agent groups are expanded, each group may issue at most one
 * lightweight probe (`COLLECTION_THREADS_LIST` with `limit: 1`). Before the
 * dedup fix, remount/re-render storms could fire dozens of identical probes.
 */

import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

interface McpToolCallBody {
  method?: string;
  params?: {
    name?: string;
    arguments?: {
      limit?: number;
      where?: { virtual_mcp_id?: string };
    };
  };
}

function isSidebarGroupProbe(body: McpToolCallBody): boolean {
  return (
    body.method === "tools/call" &&
    body.params?.name === "COLLECTION_THREADS_LIST" &&
    body.params.arguments?.limit === 1 &&
    typeof body.params.arguments.where?.virtual_mcp_id === "string"
  );
}

test.describe("Sidebar group probe dedup", () => {
  test("issues at most one probe per expanded agent group", async ({
    authedPage,
  }) => {
    test.setTimeout(120_000);
    const { page, orgSlug } = authedPage;
    const request = page.context().request;

    const stamp = Date.now();
    const agentTitles = [`ProbeAgentA-${stamp}`, `ProbeAgentB-${stamp}`];
    const agentIds: string[] = [];

    for (const title of agentTitles) {
      const vmcpResult = await callSelfMcpTool<{ item: { id: string } }>(
        request,
        orgSlug,
        "COLLECTION_VIRTUAL_MCP_CREATE",
        {
          data: {
            title,
            description: "Agent seeded for sidebar probe dedup e2e",
            connections: [],
          },
        },
      );
      agentIds.push(vmcpResult.item.id);
    }

    // 8 threads per agent (16 total) so the global initial page (10) leaves
    // partial groups while globalHasMore stays true — the probe path runs.
    for (const agentId of agentIds) {
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          callSelfMcpTool(request, orgSlug, "COLLECTION_THREADS_CREATE", {
            data: {
              title: `Probe task ${agentId}-${i + 1}`,
              virtual_mcp_id: agentId,
            },
          }),
        ),
      );
    }

    const probeCallsByAgent = new Map<string, number>();

    page.on("request", (req) => {
      if (req.method() !== "POST" || !req.url().includes("/mcp/self")) return;
      const body = req.postDataJSON() as McpToolCallBody | null;
      if (!body || !isSidebarGroupProbe(body)) return;
      const agentId = body.params!.arguments!.where!.virtual_mcp_id!;
      probeCallsByAgent.set(agentId, (probeCallsByAgent.get(agentId) ?? 0) + 1);
    });

    await page.goto(`/${orgSlug}`);
    await page.waitForURL(new RegExp(`/${orgSlug}(/|$)`), { timeout: 15_000 });

    const toggleSidebar = page.getByRole("button", { name: "Toggle sidebar" });
    await toggleSidebar.waitFor({ state: "visible", timeout: 15_000 });
    await toggleSidebar.click();

    const anyGroupHeader = page.locator('[role="button"][aria-expanded]');
    await anyGroupHeader.first().waitFor({ state: "visible", timeout: 30_000 });

    for (const title of agentTitles) {
      const groupHeader = anyGroupHeader.filter({ hasText: title }).first();
      await groupHeader.waitFor({ state: "visible", timeout: 30_000 });
      const isExpanded = await groupHeader.getAttribute("aria-expanded");
      if (isExpanded !== "true") {
        await groupHeader.click();
      }
    }

    await page.waitForTimeout(2_000);

    for (const agentId of agentIds) {
      const count = probeCallsByAgent.get(agentId) ?? 0;
      expect(count).toBeLessThanOrEqual(1);
    }

    const totalProbes = [...probeCallsByAgent.values()].reduce(
      (sum, n) => sum + n,
      0,
    );
    expect(totalProbes).toBeLessThanOrEqual(agentIds.length);
  });
});
