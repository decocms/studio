import { expect, test } from "../fixtures/test";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";

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

test.describe("standalone Blocks panel", () => {
  test.setTimeout(90_000);

  test("Chat, Blocks, and Main toggle independently on desktop", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const { agentId, threadId } = await createClonableAgent(
      page.context().request,
      orgSlug,
    );
    await page.goto(
      `/${orgSlug}/${threadId}?virtualmcpid=${agentId}&chat=1&blocks=0&main=settings`,
    );

    const chat = page.getByTestId("chat-panel");
    const blocks = page.getByTestId("blocks-panel-shell");
    const main = page.getByTestId("main-panel");
    const blocksToggle = page.getByRole("button", {
      name: "Blocks",
      exact: true,
    });

    await expect(blocksToggle).toBeVisible({ timeout: 30_000 });
    await expect(chat).toBeVisible({ timeout: 30_000 });
    await expect(main).toBeVisible();
    await expect(blocks).toBeHidden();

    await blocksToggle.click();
    await expect(page).toHaveURL(/blocks=1/);
    await expect(page).toHaveURL(/main=settings/);
    await expect(chat).toBeVisible();
    await expect(blocks).toBeVisible();
    await expect(main).toBeVisible();

    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(page).toHaveURL(/main=preview/);
    await expect(blocks).toBeVisible();

    await blocksToggle.click();
    await expect(page).toHaveURL(/blocks=0/);
    await expect(main).toBeVisible();
    await expect(blocks).toBeHidden();
  });

  test("legacy Blocks-only links preserve the final visible panel guard", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const { agentId, threadId } = await createClonableAgent(
      page.context().request,
      orgSlug,
    );
    await page.goto(
      `/${orgSlug}/${threadId}?virtualmcpid=${agentId}&main=blocks`,
    );

    const blocksToggle = page.getByRole("button", {
      name: "Blocks",
      exact: true,
    });
    await expect(blocksToggle).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("blocks-panel-shell")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("chat-panel")).toBeHidden();
    await expect(page.getByTestId("main-panel")).toBeHidden();
    await expect(blocksToggle).toBeDisabled();
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
    await page.goto(
      `/${orgSlug}/${threadId}?virtualmcpid=${agentId}&chat=1&blocks=0&main=0`,
    );

    const chatToggle = page.getByRole("button", {
      name: "Chat",
      exact: true,
    });
    await expect(chatToggle).toBeVisible({ timeout: 30_000 });
    await expect(chatToggle).toHaveAttribute("aria-pressed", "true");
    await expect(chatToggle).toBeDisabled();
    await expect(page.getByTestId("blocks-panel-shell")).toHaveCount(0);
    await expect(page.getByTestId("main-panel")).toHaveCount(0);

    const blocksToggle = page.getByRole("button", {
      name: "Blocks",
      exact: true,
    });
    await blocksToggle.click();
    await expect(page).toHaveURL(/chat=0/);
    await expect(page).toHaveURL(/blocks=1/);
    await expect(chatToggle).toHaveAttribute("aria-pressed", "false");
    await expect(blocksToggle).toHaveAttribute("aria-pressed", "true");
    await expect(blocksToggle).toBeDisabled();
    await expect(page.getByTestId("blocks-panel-shell")).toBeVisible();

    await page.getByRole("combobox", { name: "Main panel tab" }).click();
    await page.getByRole("option", { name: "Settings" }).click();
    await expect(page).toHaveURL(/blocks=0/);
    await expect(page).toHaveURL(/main=settings/);
    await expect(blocksToggle).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("main-panel")).toBeVisible();
    await expect(page.getByTestId("blocks-panel-shell")).toHaveCount(0);
  });
});
