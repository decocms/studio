/** E2E: the sandbox PreviewDrawer renders on the Site Editor and nowhere else. */
import { expect, test } from "../fixtures/test";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";

test.describe("sandbox drawer is scoped to the Site Editor", () => {
  test.describe.configure({ timeout: 240_000 });

  test("Preview, Content, and Code inherit the drawer, while Settings does not", async ({
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
    const sandboxToolbarTab = page
      .getByTestId("main-panel")
      .getByRole("button", { name: /^sandbox$/i });

    /** Every nested editor body inherits the drawer from the structural
     * parent. Navigating each URL as a fresh document guards against a drawer
     * left mounted by the previous child masking a missing composition. */
    const siteEditorBase = `/${orgSlug}/agents/${agent.item.id}/site-editor`;
    for (const child of ["", "/content", "/code"] as const) {
      const path = `${siteEditorBase}${child}`;
      await page.goto(`${path}?thread=${thread.item.id}`);
      await page.waitForURL(
        (url) =>
          url.pathname === path &&
          url.searchParams.get("thread") === thread.item.id &&
          url.searchParams.get("virtualmcpid") === null,
        { timeout: 60_000 },
      );
      await expect(
        page
          .getByTestId("main-panel")
          .locator('[data-slot="main-topbar-left"]')
          .getByRole("heading", {
            level: 1,
            name: "Site Editor",
            exact: true,
          }),
      ).toHaveCount(1);
      await expect(sandboxToolbarTab).toBeVisible({ timeout: 60_000 });
    }

    /** Wait on the settings body, so the absence below is a painted panel. */
    await page.goto(
      `/${orgSlug}/agents/${agent.item.id}/settings?thread=${thread.item.id}`,
    );
    await expect(page.getByPlaceholder("Project name")).toBeVisible({
      timeout: 60_000,
    });
    await expect(sandboxToolbarTab).toHaveCount(0);

    /** The already-bookmarked query grammar remains input-only and settles on
     *  the same canonical Site Editor route. */
    await page.goto(
      `/${orgSlug}/${thread.item.id}?virtualmcpid=${agent.item.id}&main=code`,
    );
    await page.waitForURL(
      (url) =>
        url.pathname ===
          `/${orgSlug}/agents/${agent.item.id}/site-editor/code` &&
        url.searchParams.get("thread") === thread.item.id &&
        url.searchParams.get("virtualmcpid") === null &&
        url.searchParams.get("main") === null,
      { timeout: 60_000 },
    );
    await expect(sandboxToolbarTab).toBeVisible({ timeout: 60_000 });
  });
});
