import { expect, test } from "../fixtures/test";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";

async function createClonableAgent(
  api: Parameters<typeof createHttpConnection>[0],
  orgSlug: string,
  cmsMode: "on" | "off" = "on",
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
          ui: { layout: { cms: cmsMode } },
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

  test("desktop renders Blocks and Content under the same enabled gate", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const { agentId, threadId } = await createClonableAgent(
      page.context().request,
      orgSlug,
    );
    await page.goto(
      `/${orgSlug}/${threadId}?virtualmcpid=${agentId}&sidepanel=true&main=settings`,
    );

    const chat = page.getByTestId("chat-panel");
    const main = page.getByTestId("main-panel");
    const contentTab = page.getByRole("button", {
      name: "Content",
      exact: true,
    });

    await expect(chat).toBeVisible({ timeout: 30_000 });
    await expect(main).toBeVisible();
    // Both editing surfaces are local to the Site Editor.
    await expect(contentTab).toHaveCount(0);
    await expect(page.getByTestId("blocks-panel")).toHaveCount(0);

    /* The Site Editor is opened from the SIDEBAR. Preview / Content / Code are
       a switcher WITHIN that surface, so they only render once you are on it —
       there is no "Preview" button to press from Settings. */
    await page
      .getByRole("button", { name: "Site Editor", exact: true })
      .click();
    /* The VIEW is the segment (`site-editor`, which `preview` normalises to);
       the project rides in `?virtualmcpid=`. Assert both halves: a shrinking
       path alone would also pass if the project scope had been dropped. */
    await expect(page).toHaveURL(/\/agents\/site-editor/);
    await expect(page).toHaveURL(
      (url) => url.searchParams.get("virtualmcpid") === agentId,
    );
    await expect(contentTab).toBeVisible();
    await expect(page.getByTestId("preview-blocks-toggle")).toHaveCount(0);
    await expect(page.getByTestId("blocks-panel")).toBeVisible();
    await expect(chat).toBeVisible();
    await expect(main).toBeVisible();
  });

  test("CMS off removes both Blocks and Content", async ({ authedPage }) => {
    const { page, orgSlug } = authedPage;
    const { agentId, threadId } = await createClonableAgent(
      page.context().request,
      orgSlug,
      "off",
    );

    await page.goto(
      `/${orgSlug}/${threadId}?virtualmcpid=${agentId}&sidepanel=true&main=preview`,
    );

    await expect(page.getByTestId("main-panel")).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByRole("button", { name: "Preview", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Content", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByTestId("preview-blocks-toggle")).toHaveCount(0);
    await expect(page.getByTestId("blocks-panel")).toHaveCount(0);
  });

  test("mobile renders one workspace surface at a time without Blocks", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    await page.setViewportSize({ width: 390, height: 844 });
    const { agentId, threadId } = await createClonableAgent(
      page.context().request,
      orgSlug,
    );
    await page.goto(
      `/${orgSlug}/${threadId}?virtualmcpid=${agentId}&sidepanel=false&main=preview`,
    );

    // Mobile has no side-by-side split and no standalone Chat toggle: every
    // destination (Chat, the main views, Tasks, Library) lives in the single
    // "View" dropdown, and only one surface shows at a time.
    const viewSelect = page.getByRole("combobox", { name: "View" });
    await expect(viewSelect).toBeVisible({ timeout: 30_000 });
    // Preview is the single visible surface to start.
    await expect(page.getByTestId("main-panel")).toBeVisible();
    await expect(page.getByTestId("preview-blocks-toggle")).toHaveCount(0);
    await expect(page.getByTestId("blocks-panel")).toHaveCount(0);

    // Pick Chat: main closes, but the view stays in the path so Preview returns.
    await viewSelect.click();
    await page.getByRole("option", { name: "Chat" }).click();
    await expect(page).toHaveURL(/sidepanel=true/);
    await expect(page).toHaveURL(/mainpanel=false/);
    await expect(page.getByTestId("blocks-panel")).toHaveCount(0);
    await expect(page.getByTestId("main-panel")).toHaveCount(0);

    // Pick Preview again: chat closes, the main panel returns.
    await viewSelect.click();
    await page.getByRole("option", { name: "Preview" }).click();
    await expect(page).toHaveURL(/sidepanel=false/);
    await expect(page).toHaveURL(/\/agents\/site-editor/);
    // The project scope moved from the path into search — it must still be here.
    await expect(page).toHaveURL(
      (url) => url.searchParams.get("virtualmcpid") === agentId,
    );
    await expect(page.getByTestId("main-panel")).toBeVisible();
    await expect(page.getByTestId("preview-blocks-toggle")).toHaveCount(0);
    await expect(page.getByTestId("blocks-panel")).toHaveCount(0);
  });
});
