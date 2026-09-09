import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

for (const width of [1280, 390]) {
  test(`first import offers provider selection without a URL form or legacy OAuth at ${width}px`, async ({
    authedPage: { page, orgSlug },
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
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
    await expect(dialog.getByLabel("Repository URL")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("repository-picker.png"),
      animations: "disabled",
    });
    await dialog
      .getByRole("button", { name: "Connect GitLab with a token", exact: true })
      .click();
    const tokenDialog = page.getByRole("dialog", {
      name: "Connect GitLab with a token",
      exact: true,
    });
    await expect(tokenDialog.getByLabel("Access token")).toBeVisible();
    await tokenDialog
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Import repository", exact: true }),
    ).toBeVisible();
    const connections = await callSelfMcpTool<{
      items: Array<{ slug: string }>;
    }>(page.request, orgSlug, "COLLECTION_CONNECTIONS_LIST", {});
    expect(
      connections.items.filter((item) => item.slug === "mcp-github"),
    ).toEqual([]);
  });
}

test("repository management shares the searchable picker and lives outside Storage", async ({
  authedPage: { page, orgSlug },
}, testInfo) => {
  for (const url of [
    "https://gitlab.com/example-group/example-project",
    "https://github.com/example-org/other-project",
  ]) {
    await callSelfMcpTool(page.request, orgSlug, "REPOSITORY_LINK", { url });
  }
  await page.goto(`/${orgSlug}/settings/repositories`);
  await expect(page.locator('[data-slot="settings-heading"]')).toHaveText(
    "Repositories",
    { timeout: 15000 },
  );
  await page
    .getByRole("button", { name: "Add repository", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Repository URL")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: /example-group\/example-project/ }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("repository-picker-linked.png"),
    animations: "disabled",
  });
  const search = dialog.getByPlaceholder("Search repositories");
  await search.fill("missing-project");
  await expect(
    dialog.getByText("No repositories match", { exact: true }),
  ).toBeVisible();
  await search.fill("example-group");
  await expect(
    dialog.getByRole("button", { name: /example-org\/other-project/ }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: /example-group\/example-project/ })
    .click();
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
