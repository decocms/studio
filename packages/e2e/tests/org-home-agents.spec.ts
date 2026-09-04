/**
 * E2E: the org home is the org's AGENT ROSTER, and it shows only the agents a
 * person made.
 *
 * The filter is the whole point. Every org is backfilled with the Studio Pack
 * managers (Agent Manager, Automation Manager, …), so a list that renders
 * "all agents" shows scaffolding nobody created — which is what the settings
 * Agents page does today. After filtering, a fresh org's home is the EMPTY
 * state, and that is the common first-run path rather than a rare one.
 *
 * Wire-contract strings (paths, tool names, visible copy) are inlined by hand
 * on purpose — this suite owns its contract and imports no app code (see
 * `plugins/ban-e2e-app-imports.js`).
 */

import type { APIRequestContext, Page } from "@playwright/test";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

/** Cold-Vite route compiles are slow on a loaded box, and this crosses the
 *  shell plus a lazy main-panel view. */
const SHELL_TIMEOUT_MS = 90_000;

async function createAgent(
  request: APIRequestContext,
  orgSlug: string,
  title: string,
): Promise<string> {
  const connection = await createHttpConnection(request, orgSlug, {
    title: `${title} placeholder`,
    url: "http://127.0.0.1:1/unused",
  });
  const agent = await callSelfMcpTool<{ item: { id: string } }>(
    request,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title,
        status: "active",
        pinned: false,
        connections: [{ connection_id: connection.id }],
      },
    },
  );
  return agent.item.id;
}

async function assertCanonicalNewProjectHome(
  page: Page,
  orgSlug: string,
): Promise<void> {
  await page.waitForURL(
    (url) =>
      url.pathname === `/${orgSlug}/home` &&
      url.searchParams.get("virtualmcpid") === null,
    { timeout: SHELL_TIMEOUT_MS },
  );
  const landed = new URL(page.url());
  expect(landed.pathname).not.toContain("/agents/");
  await expect(page.getByTestId("main-panel")).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await expect(
    page.getByRole("button", { name: "Import from GitHub" }),
  ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
}

test.describe("org home — the agent roster", () => {
  test.describe.configure({ timeout: 180_000 });

  test("lists the agents a person made and hides the Studio Pack managers", async ({
    authedPage: { page, orgSlug },
  }) => {
    /* Tenant-scoped: a title unique to this run, so the assertion cannot read
       another worker's row. */
    const title = `Roster Agent ${orgSlug}`;
    await createAgent(page.request, orgSlug, title);

    await page.goto(`/${orgSlug}/home`);
    const mainPanel = page.getByTestId("main-panel");
    await expect(mainPanel).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });

    await expect(
      mainPanel.getByRole("button", { name: title, exact: true }),
    ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

    /* The backfilled managers are plumbing, not the org's work. If this ever
       fails, the home is rendering the unfiltered list again. */
    for (const manager of ["Agent Manager", "Automation Manager"]) {
      await expect(mainPanel.getByText(manager, { exact: true })).toHaveCount(
        0,
      );
    }
  });

  test("a fresh org lands on the empty state, with GitHub import offered", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.goto(`/${orgSlug}/home`);
    await expect(page.getByTestId("main-panel")).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });

    /* Nothing was created in this org, and the managers are filtered out — so
       the roster is empty even though the org has rows. */
    await expect(page.getByText("No projects yet")).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
    await expect(
      page.getByRole("button", { name: "Import from GitHub" }),
    ).toBeVisible();
  });

  test("the command palette New project action opens organization Home", async ({
    authedPage: { page, orgSlug },
  }) => {
    /** Exercise the populated-home branch too: the entry action and the
     * import control are permanent affordances, not empty-state behavior. */
    await createAgent(page.request, orgSlug, `Palette Agent ${orgSlug}`);
    await page.goto(`/${orgSlug}/reports`);
    await expect(page.getByTestId("main-panel")).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });

    const modifier = await page.evaluate(() =>
      /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta" : "Control",
    );
    await page.keyboard.press(`${modifier}+K`);
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(
      palette.getByRole("option", { name: "Discover", exact: true }),
    ).toHaveCount(0);
    await palette
      .getByRole("option", { name: "New project", exact: true })
      .click();

    await assertCanonicalNewProjectHome(page, orgSlug);
  });

  test("the organization and project picker New project action opens organization Home", async ({
    authedPage: { page, orgSlug },
  }) => {
    const agentId = await createAgent(
      page.request,
      orgSlug,
      `Picker Agent ${orgSlug}`,
    );
    await page.goto(`/${orgSlug}/agents/${agentId}/settings`);
    await expect(page.getByTestId("main-panel")).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });

    await page
      .getByRole("button", { name: /^Organization and project:/ })
      .click();
    await expect(
      page.getByPlaceholder("Search organizations and projects…"),
    ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await page
      .getByRole("button", { name: "New project", exact: true })
      .click();

    await assertCanonicalNewProjectHome(page, orgSlug);
  });
});
