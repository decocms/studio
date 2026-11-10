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
      .getByTestId("main-panel")
      .locator("nav")
      .filter({ has: page.getByRole("link", { name: "Repository" }) });
    const content = page.locator('[data-slot="page-content"]');
    const name = content.getByRole("textbox", { name: "Project name" });
    await expect(name).toHaveValue("Forma", { timeout: 60_000 });
    await expect(tabs.getByRole("link")).toHaveText([
      "General",
      "Views",
      "Repository",
      "CMS",
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
    await tabs.getByRole("link", { name: "Views" }).click();
    await expect(
      content.getByRole("heading", { name: "Default layout" }),
    ).toBeVisible();
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

    // The layout settings have their own Views section.
    await expect(tabs.locator('[aria-current="page"]')).toHaveText("General");
    await tabs.getByRole("link", { name: "Views" }).click();
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
    await page.goto(`${path}?section=unknown`);
    await expect(name).toHaveValue("Forma Studio");
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
    const tabs = page
      .getByTestId("main-panel")
      .locator("nav")
      .filter({ has: page.getByRole("link", { name: "Repository" }) });
    await expect(
      tabs.getByRole("link", { name: "CMS", exact: true }),
    ).toHaveAttribute("aria-current", "page", { timeout: 60_000 });
    const previewServer = page.getByRole("textbox", {
      name: "Preview server",
      exact: true,
    });
    await expect(previewServer).toHaveValue("https://forma.example.com/");
    await previewServer.fill("https://preview.forma.example.com/");
    // The section saves on its own; switching away before then drops the edit.
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
    await tabs.getByRole("link", { name: "Views", exact: true }).click();
    await expect(
      tabs.getByRole("link", { name: "Views", exact: true }),
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
  test("an org owner turns a project into a Blocks v8 site and back from the CMS tab", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const request = page.context().request;
    const owner = uniqueOwner();
    const repo = "forma-v8";
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
      siteSlug: owner,
    });
    const isV8 = async () => {
      const { item } = await callSelfMcpTool<{
        item: { metadata: Record<string, unknown> | null };
      }>(request, orgSlug, "COLLECTION_VIRTUAL_MCP_GET", {
        id: project.vmcpId,
      });
      return item.metadata?.blocksV8 === true;
    };
    const pushSchema = () =>
      request.put(`/api/cms/${owner}/schema`, {
        data: JSON.stringify({ blocksMajor: 8, definitions: {}, root: {} }),
        headers: { "Content-Type": "application/json" },
      });
    await page.goto(
      `/${orgSlug}/projects/${project.vmcpId}/settings?section=site`,
    );
    const toggle = page.getByRole("switch", { name: "Blocks v8 site" });
    // A v7 site: the switch is off, and the v7 Fast Preview switch is there.
    await expect(toggle).toHaveAttribute("aria-checked", "false", {
      timeout: 60_000,
    });
    await expect(
      page.getByRole("switch", { name: "Fast Preview" }),
    ).toBeVisible();
    expect((await pushSchema()).status()).toBe(409);
    expect(await isV8()).toBe(false);

    await toggle.click();
    await expect.poll(isV8).toBe(true);
    // The v8 gates follow: no Fast Preview switch (always on), site tokens.
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(
      page.getByRole("switch", { name: "Fast Preview" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Site tokens" }),
    ).toBeVisible();
    expect((await pushSchema()).status()).toBe(200);
    // A schema push never turns it off either.
    expect(await isV8()).toBe(true);

    await toggle.click();
    await expect.poll(isV8).toBe(false);
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(
      page.getByRole("switch", { name: "Fast Preview" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Site tokens" }),
    ).toHaveCount(0);
  });
});
