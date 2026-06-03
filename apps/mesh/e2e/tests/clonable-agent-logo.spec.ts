/**
 * E2E: clonable agents (connected GitHub repo) allow editing the icon/logo
 * on the settings tab. Title, description, and instructions remain locked
 * to the repo — those are intentionally NOT asserted here.
 *
 * See docs/superpowers/specs/2026-06-03-clonable-agent-logo-editable-design.md
 */
import { expect, test } from "../fixtures/test";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";

test.describe("clonable agent logo (settings tab)", () => {
  test("icon picker is interactive when the agent has a connected GitHub repo", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;

    // Create a placeholder connection. The URL doesn't have to resolve;
    // the UI only needs its id to make `agentHasConnectedGithub` true.
    const conn = await createHttpConnection(api, orgSlug, {
      title: "github-placeholder",
      url: "http://127.0.0.1:1/unused",
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
          title: "clonable logo e2e",
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

    // Sanity-check the asymmetry first: the title input is still disabled,
    // confirming the agent is clonable (agentHasConnectedGithub === true).
    // If this fails, the metadata wiring or the route navigation broke,
    // and the icon-button assertion below would be testing the wrong thing.
    await expect(titleInput).toBeDisabled();

    // The IconPicker trigger is the first <button> in the identity row,
    // which is two ancestors up from the title input
    // (input → col div → row div).
    const identityRow = titleInput.locator("xpath=../..");
    const iconButton = identityRow.locator("button").first();

    // The assertion under test: the button must be enabled. Without the
    // fix, `disabled={hasGithubRepo}` makes this fail with the trigger
    // button reporting `disabled`.
    await expect(iconButton).toBeEnabled();
  });
});
