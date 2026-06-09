/**
 * E2E: the sandbox PreviewDrawer renders below every main-panel tab on
 * cloneable agents — not just the preview tab. See spec at
 * docs/superpowers/specs/2026-06-03-sandbox-drawer-everywhere-design.md.
 */
import { expect, test } from "../fixtures/test";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";

test.describe("sandbox drawer is available on every main-panel tab", () => {
  test("drawer toolbar renders on Settings and Preview tabs", async ({
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
          title: "drawer-everywhere e2e",
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

    // Active tab is driven by ?main=… (see tab-id.ts grammar). Start on the
    // settings tab — the most common non-preview tab and a strong signal
    // that the drawer has been hoisted out of PreviewContent.
    await page.goto(
      `/${orgSlug}/${thread.item.id}?virtualmcpid=${agent.item.id}&main=settings`,
    );
    await expect(sandboxToolbarTab).toBeVisible({ timeout: 15_000 });

    // Switch to the preview tab via URL — the drawer was already visible
    // here before the refactor, so this is the regression-prevention half.
    await page.goto(
      `/${orgSlug}/${thread.item.id}?virtualmcpid=${agent.item.id}&main=preview`,
    );
    await expect(sandboxToolbarTab).toBeVisible({ timeout: 15_000 });
  });
});
