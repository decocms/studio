/**
 * E2E: the `terminalVisibleByDefault` user preference drives whether the
 * sandbox PreviewDrawer shows by default, and a per-VM Show/Hide override wins
 * over that default.
 *
 * Storage contract (black-box, asserted here on purpose):
 *   - `studio:user:preferences` — the usePreferences() blob; `terminalVisibleByDefault`
 *     is the new default (see apps/web/src/hooks/use-preferences.ts).
 *   - `preview-terminal-visible:<virtualMcpId>` — the per-VM override
 *     `{ visible: boolean }` (see terminal-visibility.tsx). Absent → use default.
 */
import { expect, test } from "../fixtures/test";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";

const PREFERENCES_KEY = "studio:user:preferences";

/** Create a cloneable agent + thread so the drawer chrome is eligible to mount. */
async function createCloneableAgentThread(
  api: import("@playwright/test").APIRequestContext,
  orgSlug: string,
) {
  // Placeholder GitHub connection — only its id matters, so
  // `agentHasClonableSource` flips on.
  const conn = await createHttpConnection(api, orgSlug, {
    title: "github-placeholder",
    url: "http://127.0.0.1:1/unused",
  });
  const agent = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title: "terminal-default-visibility e2e",
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
  return { agentId: agent.item.id, threadId: thread.item.id };
}

test.describe("sandbox terminal default visibility preference", () => {
  test("default shows the drawer; a per-VM Hide override wins", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const { agentId, threadId } = await createCloneableAgentThread(
      api,
      orgSlug,
    );

    // Turn the default ON via the preferences blob. usePreferences() merges
    // over DEFAULT_PREFERENCES, so seeding only this field is enough.
    await page.addInitScript(
      ({ key, value }) => localStorage.setItem(key, value),
      {
        key: PREFERENCES_KEY,
        value: JSON.stringify({ terminalVisibleByDefault: true }),
      },
    );

    // The drawer's setup tab is a <button> reading "sandbox" (drawer/toolbar.tsx
    // :: SetupTab) — the cheap proof that the drawer chrome is mounted.
    const sandboxToolbarTab = page.getByRole("button", { name: /^sandbox$/i });

    // With the default ON and NO per-VM override, the drawer shows.
    await page.goto(
      `/${orgSlug}/${threadId}?virtualmcpid=${agentId}&main=preview`,
    );
    await expect(sandboxToolbarTab).toBeVisible({ timeout: 15_000 });

    // Now set an explicit per-VM Hide. This survives the reload (addInitScript
    // only reseeds the preferences key, not this one), so it proves the
    // override beats the still-ON default.
    await page.evaluate(
      (key) => localStorage.setItem(key, JSON.stringify({ visible: false })),
      `preview-terminal-visible:${agentId}`,
    );
    await page.reload();

    // Non-vacuous transition: the drawer was visible above, so its
    // disappearance here is driven by the override, not by a slow load.
    await expect(sandboxToolbarTab).toBeHidden({ timeout: 15_000 });
  });
});
