/** E2E: the sandbox PreviewDrawer renders on the Site Editor and nowhere else. */
import { expect, test } from "../fixtures/test";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";

test.describe("sandbox drawer is scoped to the Site Editor", () => {
  test("drawer toolbar renders on the Site Editor and not on Settings", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;

    // Placeholder GitHub connection — the URL doesn't need to resolve; only
    // its id is needed so `agentHasClonableSource` flips on.
    const conn = await createHttpConnection(api, orgSlug, {
      title: "github-placeholder",
      url: "http://127.0.0.1:1/unused",
    });

    // Clonable agent: connections[] AND metadata.githubRepo both reference
    // the same connection id (both halves are required for
    // `getActiveGithubRepo` → non-null, which is what
    // `agentHasClonableSource` checks).
    const agent = await callSelfMcpTool<{ item: { id: string } }>(
      api,
      orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      {
        data: {
          title: "drawer site-editor e2e",
          description: "cloneable",
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

    // The drawer's setup tab is a <button> with visible text "sandbox" and
    // a Terminal icon (see drawer/toolbar.tsx :: SetupTab). Asserting on it
    // is the cheap proof that the drawer chrome is mounted under the tab;
    // we deliberately don't try to start the sandbox.
    const sandboxToolbarTab = page.getByRole("button", { name: /^sandbox$/i });

    /** The legacy `?main=preview` is translated to `site-editor` on entry. */
    await page.goto(
      `/${orgSlug}/${thread.item.id}?virtualmcpid=${agent.item.id}&main=preview`,
    );
    await expect(sandboxToolbarTab).toBeVisible({ timeout: 15_000 });

    /** Wait on the settings body, so the absence below is a painted panel. */
    await page.goto(
      `/${orgSlug}/${thread.item.id}?virtualmcpid=${agent.item.id}&main=settings`,
    );
    await expect(page.getByPlaceholder("Project name")).toBeVisible({
      timeout: 15_000,
    });
    await expect(sandboxToolbarTab).toHaveCount(0);
  });
});
