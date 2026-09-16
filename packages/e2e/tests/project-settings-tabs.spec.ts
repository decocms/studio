import { expect, test } from "../fixtures/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import {
  createFastPreviewProject,
  seedStubRepo,
  uniqueOwner,
} from "../fixtures/fast-preview";

test.describe("project settings tabs", () => {
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
    const path = `/${orgSlug}/projects/${item.id}/settings`;
    await page.goto(path);
    const header = page.getByTestId("page-header");
    const tabs = page
      .locator('[data-slot="panel-toolbar"]')
      .getByRole("navigation", { name: "Project settings sections" });
    const content = page.locator('[data-slot="page-content"]');
    const name = content.getByRole("textbox", { name: "Project name" });
    await expect(name).toHaveValue("Forma", { timeout: 60_000 });
    await expect(
      header.getByRole("heading", { level: 1, name: "Project settings" }),
    ).toBeVisible();
    await expect(tabs.getByRole("link")).toHaveText([
      "General",
      "Connections",
      "Site",
      "Views",
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
      content.getByRole("heading", { name: "Connected tools" }),
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
    await expect(
      header.getByRole("link", { name: "Forma Studio", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(name).toHaveValue("Forma Studio");

    await tabs.getByRole("link", { name: "Views", exact: true }).click();
    await expect(page).toHaveURL(
      (url) => url.searchParams.get("section") === "views",
    );
    await expect(tabs.locator('[aria-current="page"]')).toHaveText("Views");
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
    await expect(
      content.getByRole("textbox", { name: "Description" }),
    ).toBeInViewport();
    await expect(
      header.getByRole("button", { name: "Connect", exact: true }),
    ).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    const headingColor = await content
      .getByRole("heading", { name: "Project details" })
      .evaluate((element) => getComputedStyle(element).color);
    await expect(name).toHaveCSS("color", headingColor);
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("project-settings-mobile.png"),
    });
    await tabs.getByRole("link", { name: "Connections" }).click();
    await expect(
      header.getByRole("button", { name: "Add connection", exact: true }),
    ).toBeInViewport();
    await page.goto(`${path}?section=unknown`);
    await expect(name).toHaveValue("Forma Studio");
    await expect(tabs.getByRole("link", { name: "General" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("existing Site links keep preview settings editable across tab changes", async ({
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
    const path = `/${orgSlug}/projects/${project.vmcpId}/settings`;
    await page.goto(`${path}?section=site`);
    const tabs = page.getByRole("navigation", {
      name: "Project settings sections",
    });
    await expect(
      tabs.getByRole("link", { name: "Site", exact: true }),
    ).toHaveAttribute("aria-current", "page", { timeout: 60_000 });
    const previewServer = page.getByRole("textbox", {
      name: "Preview server",
      exact: true,
    });
    await expect(previewServer).toHaveValue("https://forma.example.com/");
    await previewServer.fill("https://preview.forma.example.com/");
    await tabs.getByRole("link", { name: "Views", exact: true }).click();
    await expect(
      tabs.getByRole("link", { name: "Views", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await page.goBack();
    await expect(previewServer).toHaveValue(
      "https://preview.forma.example.com/",
    );
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
