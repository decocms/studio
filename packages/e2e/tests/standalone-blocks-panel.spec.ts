import { expect, test } from "../fixtures/test";
import {
  callSelfMcpTool,
  createHttpConnection,
  setOrgFlags,
} from "../fixtures/mcp-tools";

async function createClonableAgent(
  api: Parameters<typeof createHttpConnection>[0],
  orgSlug: string,
) {
  await callSelfMcpTool(api, orgSlug, "AI_PROVIDER_KEY_CREATE", {
    providerId: "anthropic",
    label: "standalone-blocks-panel-e2e",
    apiKey: "sk-ant-e2e-fake-key-do-not-use",
  });
  const connection = await createHttpConnection(api, orgSlug, {
    title: "standalone-blocks-placeholder",
    url: "http://127.0.0.1:1/unused",
  });
  const agent = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title: "standalone Blocks panel e2e",
        description: "cloneable",
        status: "active",
        pinned: false,
        connections: [{ connection_id: connection.id }],
        metadata: {
          githubRepo: {
            url: "https://github.com/example/repo",
            owner: "example",
            name: "repo",
            connectionId: connection.id,
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

test.describe("Blocks preview mode", () => {
  test.setTimeout(90_000);

  test("desktop keeps Chat independent and removes Blocks from the workspace toolbar", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const { agentId, threadId } = await createClonableAgent(
      page.context().request,
      orgSlug,
    );
    await page.goto(
      `/${orgSlug}/${threadId}?virtualmcpid=${agentId}&sidepanel=chat&main=settings`,
    );

    const chat = page.getByTestId("chat-panel");
    const main = page.getByTestId("main-panel");
    const legacyBlocksToggle = page.getByRole("button", {
      name: "Blocks",
      exact: true,
    });

    await expect(chat).toBeVisible({ timeout: 30_000 });
    await expect(main).toBeVisible();
    await expect(legacyBlocksToggle).toHaveCount(0);
    await expect(page.getByTestId("blocks-panel")).toHaveCount(0);

    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(page).toHaveURL(/main=preview/);
    await expect(chat).toBeVisible();
    await expect(main).toBeVisible();
  });

  test("mobile renders one workspace surface at a time", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    await page.setViewportSize({ width: 390, height: 844 });
    const { agentId, threadId } = await createClonableAgent(
      page.context().request,
      orgSlug,
    );
    // The View dropdown drops its Settings option under the new nav.
    await setOrgFlags(page.context().request, orgSlug, { nav_v2: false });
    await page.goto(
      `/${orgSlug}/${threadId}?virtualmcpid=${agentId}&sidepanel=0&main=settings`,
    );

    // Mobile has no side-by-side split and no standalone Chat toggle: every
    // destination (Chat, the main views, Tasks, Library) lives in the single
    // "View" dropdown, and only one surface shows at a time.
    const viewSelect = page.getByRole("combobox", { name: "View" });
    await expect(viewSelect).toBeVisible({ timeout: 30_000 });
    // main=settings is the single visible surface to start.
    await expect(page.getByTestId("main-panel")).toBeVisible();

    // Pick Chat: the main panel closes and chat becomes the only surface.
    await viewSelect.click();
    await page.getByRole("option", { name: "Chat" }).click();
    await expect(page).toHaveURL(/sidepanel=chat/);
    await expect(page).toHaveURL(/main=0/);
    await expect(page.getByTestId("blocks-panel")).toHaveCount(0);
    await expect(page.getByTestId("main-panel")).toHaveCount(0);

    // Pick Settings again: chat closes, the main panel returns.
    await viewSelect.click();
    await page.getByRole("option", { name: "Settings" }).click();
    await expect(page).toHaveURL(/sidepanel=0/);
    await expect(page).toHaveURL(/main=settings/);
    await expect(page.getByTestId("main-panel")).toBeVisible();
    await expect(page.getByTestId("blocks-panel")).toHaveCount(0);
  });
});
