import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

test("first import offers providers and URL entry without starting legacy OAuth", async ({
  authedPage: { page, orgSlug },
}, testInfo) => {
  await page.goto(`/${orgSlug}/home`);
  await page
    .getByRole("button", { name: "Import repository", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", {
      name: "Connect GitLab with a token",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Connect GitHub", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel("Repository URL")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("repository-picker.png"),
    animations: "disabled",
  });
  const connections = await callSelfMcpTool<{ items: Array<{ slug: string }> }>(
    page.request,
    orgSlug,
    "COLLECTION_CONNECTIONS_LIST",
    {},
  );
  expect(
    connections.items.filter((item) => item.slug === "mcp-github"),
  ).toEqual([]);
});

test("repository management shares the picker and lives outside Storage", async ({
  authedPage: { page, orgSlug },
}) => {
  await page.goto(`/${orgSlug}/settings/repositories`);
  await expect(page.locator('[data-slot="settings-heading"]')).toHaveText(
    "Repositories",
  );
  await page
    .getByRole("button", { name: "Add repository", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", {
      name: "Connect GitLab with a token",
      exact: true,
    }),
  ).toBeVisible();
  await expect(dialog.getByLabel("Repository URL")).toBeVisible();
  await dialog
    .getByLabel("Repository URL")
    .fill("https://gitlab.com/example-group/example-project");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId("repositories-list")).toContainText(
    "example-group/example-project",
  );
});

test("home imports an already linked GitLab repository as an agent without a GitHub connection", async ({
  authedPage: { page, orgSlug },
}) => {
  const { repository } = await callSelfMcpTool<{ repository: { id: string } }>(
    page.request,
    orgSlug,
    "REPOSITORY_LINK",
    { url: "https://gitlab.com/example-group/nested/import-project" },
  );
  await page.goto(`/${orgSlug}/home`);
  await page
    .getByRole("button", { name: "Import repository", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /example-group\/nested\/import-project/ })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const { items } = await callSelfMcpTool<{
    items: Array<{
      title: string;
      metadata: { githubRepo?: { repositoryId: string } } | null;
    }>;
  }>(page.request, orgSlug, "COLLECTION_VIRTUAL_MCP_LIST", {});
  const imported = items.filter(
    (item) => item.metadata?.githubRepo?.repositoryId === repository.id,
  );
  expect(imported).toHaveLength(1);
  expect(imported[0]?.title).toBe("import-project");
});
