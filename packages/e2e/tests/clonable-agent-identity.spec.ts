/**
 * E2E: clonable agents (connected GitHub repo) allow editing their whole
 * identity — icon/logo, name and description — on the settings tab. A linked
 * repo is addressed by `metadata.githubRepo` and its site tenancy by
 * `metadata.siteSlug`, so neither is keyed off the title and none of these
 * fields needs to be read-only.
 */
import { expect, test } from "../fixtures/test";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";

test.describe("clonable agent identity (settings tab)", () => {
  test("icon, name and description are editable when the agent has a connected GitHub repo", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;

    // Create a placeholder connection. Use the test studio server as a dummy URL
    // since tool validation now requires a reachable endpoint. We only need the
    // connection ID to populate `agentHasConnectedGithub`; the URL itself is unused.
    const conn = await createHttpConnection(api, orgSlug, {
      title: "github-placeholder",
      url: "http://127.0.0.1:3000/",
    });

    // Create the clonable agent: connections[] AND metadata.githubRepo
    // both reference the same connection id — both halves are required
    // for `getActiveGithubRepo` to return a non-null repo.
    const agent = await callSelfMcpTool<{ item: { id: string } }>(
      api,
      orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      {
        data: {
          title: "clonable identity e2e",
          description: "from a repo",
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

    // Open the agent shell with the settings tab forced active. The active
    // tab is driven by ?main=..., not ?tab=... — see use-main-panel-tabs.ts.
    await page.goto(
      `/${orgSlug}/${thread.item.id}?virtualmcpid=${agent.item.id}&main=settings`,
    );

    // The settings tab renders the title input with placeholder "Agent
    // name" — present regardless of value, so getByPlaceholder is robust.
    const titleInput = page.getByPlaceholder("Agent name");
    await expect(titleInput).toBeVisible({ timeout: 15_000 });

    // The IconPicker trigger button is tagged with data-testid so the
    // locator doesn't depend on DOM-tree shape (button order, wrapper
    // divs, etc.). The testid lives on the <button> at the root of
    // <IconPicker> in apps/web/src/components/icon-picker.tsx.
    const iconButton = page.getByTestId("icon-picker-trigger");

    // Under test: `disabled={hasGithubRepo}` locked each of these.
    await expect(iconButton).toBeEnabled();
    await expect(titleInput).toBeEnabled();
    const descriptionInput = page.getByPlaceholder("Add a description...");
    await expect(descriptionInput).toBeEnabled();

    // A rename must reach the row — the form autosaves on blur.
    const renamed = `renamed identity e2e ${Date.now()}`;
    await titleInput.fill(renamed);
    await titleInput.blur();

    await expect
      .poll(
        async () => {
          const got = await callSelfMcpTool<{ item: { title: string } }>(
            api,
            orgSlug,
            "COLLECTION_VIRTUAL_MCP_GET",
            { id: agent.item.id },
          );
          return got.item.title;
        },
        { timeout: 15_000 },
      )
      .toBe(renamed);
  });
});
