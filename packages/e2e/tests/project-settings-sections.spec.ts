import { expect, test } from "../fixtures/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import {
  createFastPreviewProject,
  seedStubRepo,
  uniqueOwner,
} from "../fixtures/fast-preview";

/** A project's settings are sections of its Context, beside its files. */
test.describe("project settings sections", () => {
  test.setTimeout(120_000);

  test("tabs share the page header and preserve edits, history, and view preferences", async ({
    authedPage: { page, orgSlug },
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const request = page.context().request;
    const { item } = await callSelfMcpTool<{ item: { id: string } }>(
      request,
      orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      {
        data: {
          title: "Forma",
          description: "Considered objects for everyday living.",
          status: "active",
          connections: [],
        },
      },
    );
    const path = `/${orgSlug}/projects/${item.id}/library`;
    await page.goto(`${path}?section=general`);
    const header = page.getByTestId("page-header");
    const tabs = page
      .getByTestId("main-panel")
      .locator("nav")
      .filter({ has: page.getByRole("link", { name: "Instructions" }) });
    const content = page.locator('[data-slot="page-content"]');
    const name = content.getByRole("textbox", { name: "Project name" });
    await expect(name).toHaveValue("Forma", { timeout: 60_000 });
    await expect(
      header.getByRole("heading", { level: 1, name: "General" }),
    ).toBeVisible();
    await expect(tabs.getByRole("link")).toHaveText([
      "All files",
      "Instructions",
      "Connections",
      "CMS",
      "General",
    ]);
    await expect(tabs.getByRole("link", { name: "General" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("project-settings-general.png"),
    });

    await name.fill("Forma Studio");
    await tabs.getByRole("link", { name: "Connections" }).click();
    await expect(
      content.getByRole("button", {
        name: "No connections yet. Add one to get started.",
      }),
    ).toBeVisible();
    await header
      .getByRole("button", { name: "Add connection", exact: true })
      .click();
    const addConnection = page.getByRole("dialog");
    await expect(addConnection).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(addConnection).toBeHidden();
    await page.goBack();
    await expect(name).toHaveValue("Forma Studio");
    await expect
      .poll(async () => {
        const { item: saved } = await callSelfMcpTool<{
          item: { title: string };
        }>(request, orgSlug, "COLLECTION_VIRTUAL_MCP_GET", { id: item.id });
        return saved.title;
      })
      .toBe("Forma Studio");
    await page.reload();
    await expect(name).toHaveValue("Forma Studio");

    // The layout settings lead General rather than living in a tab of their own.
    await expect(tabs.locator('[aria-current="page"]')).toHaveText("General");
    await expect(
      content.getByRole("heading", { name: "Default layout" }),
    ).toBeVisible();
    const mainView = content.getByRole("combobox", { name: "Main view" });
    const automations = content.getByRole("button", { name: /^Automations\b/ });
    await automations.getByRole("button", { name: "Pin to sidebar" }).click();
    await expect(
      automations.getByRole("button", { name: "Remove from sidebar" }),
    ).toHaveAttribute("aria-pressed", "true");
    await mainView.click();
    await page
      .getByRole("option", { name: "Automations", exact: true })
      .click();
    await expect
      .poll(async () => {
        const saved = await callSelfMcpTool<{
          item: {
            metadata: {
              sidebarViews?: string[];
              ui?: {
                layout?: { defaultMainView?: { type: string } | null } | null;
              } | null;
            };
          };
        }>(request, orgSlug, "COLLECTION_VIRTUAL_MCP_GET", { id: item.id });
        return {
          main: saved.item.metadata.ui?.layout?.defaultMainView?.type,
          automationsPinned:
            saved.item.metadata.sidebarViews?.includes("automations"),
        };
      })
      .toEqual({ main: "automations", automationsPinned: true });
    await page.reload();
    await expect(mainView).toHaveText("Automations");
    await expect(
      automations.getByRole("button", { name: "Remove from sidebar" }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("project-settings-views.png"),
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(mainView).toBeInViewport();
    await tabs.getByRole("link", { name: "General" }).click();
    await expect(name).toBeInViewport();
    const description = content.getByRole("textbox", { name: "Description" });
    await description.scrollIntoViewIfNeeded();
    await expect(description).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    const labelColor = await content
      .getByText("Project name", { exact: true })
      .evaluate((element) => getComputedStyle(element).color);
    await expect(name).toHaveCSS("color", labelColor);
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("project-settings-mobile.png"),
    });
    await tabs.getByRole("link", { name: "Connections" }).click();
    await expect(
      header.getByRole("button", { name: "Add connection", exact: true }),
    ).toBeInViewport();
  });

  test("existing Site links keep preview settings editable across section changes", async ({
    authedPage: { page, orgSlug },
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const request = page.context().request;
    const owner = uniqueOwner();
    const repo = "forma-settings";
    await seedStubRepo(request, {
      owner,
      repo,
      branches: { main: { files: {} } },
    });
    const project = await createFastPreviewProject(request, orgSlug, {
      owner,
      repo,
      connectionUrl: "http://127.0.0.1:1/unused",
      previewServerUrl: "https://forma.example.com/",
    });
    // The settings route of old links lands on the same Context section.
    const path = `/${orgSlug}/projects/${project.vmcpId}/settings`;
    await page.goto(`${path}?section=site`);
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/projects/${project.vmcpId}/library` &&
        url.searchParams.get("section") === "site",
    );
    const tabs = page
      .getByTestId("main-panel")
      .locator("nav")
      .filter({ has: page.getByRole("link", { name: "Instructions" }) });
    await expect(
      tabs.getByRole("link", { name: "CMS", exact: true }),
    ).toHaveAttribute("aria-current", "page", { timeout: 60_000 });
    const previewServer = page.getByRole("textbox", {
      name: "Preview server",
      exact: true,
    });
    await expect(previewServer).toHaveValue("https://forma.example.com/");
    await previewServer.fill("https://preview.forma.example.com/");
    await expect
      .poll(async () => {
        const { item } = await callSelfMcpTool<{
          item: { metadata: { previewServerUrl: string } };
        }>(request, orgSlug, "COLLECTION_VIRTUAL_MCP_GET", {
          id: project.vmcpId,
        });
        return item.metadata.previewServerUrl;
      })
      .toBe("https://preview.forma.example.com/");
    await tabs.getByRole("link", { name: "Connections", exact: true }).click();
    await expect(
      tabs.getByRole("link", { name: "Connections", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await page.goBack();
    await expect(previewServer).toHaveValue(
      "https://preview.forma.example.com/",
    );
    await page.reload();
    await expect(previewServer).toHaveValue(
      "https://preview.forma.example.com/",
    );
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("project-settings-site.png"),
    });
  });
});
