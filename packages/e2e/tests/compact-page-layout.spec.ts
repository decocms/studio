import { startPreviewSite } from "../fixtures/preview-site";
import { expect, test } from "../fixtures/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import {
  createFastPreviewProject,
  seedStubRepo,
  uniqueOwner,
} from "../fixtures/fast-preview";

test.use({ compactPageLayout: true });

test.describe("compact page layout", () => {
  test.setTimeout(120_000);

  test("page headings and actions stay in the shared header across org, project, and settings routes", async ({
    authedPage: { page, orgSlug, user },
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await callSelfMcpTool(page.request, orgSlug, "TASK_BOARD_ITEM_CREATE", {
      title: "Review the compact layout",
    });
    await page.goto(`/${orgSlug}/home`);
    const header = page.getByTestId("page-header");
    await expect(
      header.getByRole("heading", { level: 1, name: "Home", exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    // The org is named by the sidebar's picker, not by the page title.
    await expect(
      page
        .locator('[data-slot="sidebar-picker-header"]')
        .getByText(user.orgName),
    ).toBeVisible();
    await expect(
      header.getByRole("button", { name: "New Project" }),
    ).toBeVisible();
    await expect(page.locator('[data-slot="panel-toolbar"]')).toBeHidden();
    await expect(
      header.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link"),
    ).toHaveCount(0);
    await header.screenshot({
      path: testInfo.outputPath("compact-org-home-header.png"),
    });

    const { item: project } = await callSelfMcpTool<{ item: { id: string } }>(
      page.request,
      orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      { data: { title: "Forma", status: "active", connections: [] } },
    );
    await page.goto(`/${orgSlug}/projects/${project.id}`);
    await expect(
      header.getByRole("heading", { level: 1, name: "Forma", exact: true }),
    ).toBeVisible();
    const breadcrumbs = header.getByRole("navigation", { name: "Breadcrumbs" });
    // The org is never a crumb, so a project's home has no trail above its
    // title — the way back out is the sidebar's own row.
    await expect(breadcrumbs.getByRole("link")).toHaveCount(0);
    await expect(header.getByText("Overview", { exact: true })).toHaveCount(0);
    await header.screenshot({
      path: testInfo.outputPath("compact-project-home-header.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      header.getByRole("heading", { name: "Forma", exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 720 });
    const sidebar = page.locator('[data-slot="sidebar"]');
    await sidebar
      .getByRole("button", { name: "All projects", exact: true })
      .click();
    await expect(
      header.getByRole("heading", { name: "Home", exact: true }),
    ).toBeVisible();
    await expect(sidebar.getByText("Projects", { exact: true })).toBeVisible();
    await expect(
      sidebar.getByRole("link", { name: "Members", exact: true }),
    ).toHaveCount(0);
    await sidebar
      .getByRole("button", { name: "Add project", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Import repository", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    const sidebarHeader = await sidebar
      .locator('[data-slot="sidebar-picker-header"]')
      .boundingBox();
    const pageHeader = await header.boundingBox();
    expect(Math.abs(sidebarHeader!.y - pageHeader!.y)).toBeLessThanOrEqual(1);
    expect(sidebarHeader!.height).toBe(pageHeader!.height);
    await sidebar.getByRole("link", { name: "Board", exact: true }).click();
    await expect(
      header.getByRole("heading", { name: "Tasks", exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      header.getByRole("button", { name: "New task", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    const bounds = await header.boundingBox();
    expect(bounds?.height).toBe(48);
    const views = page.locator('[data-slot="panel-toolbar-left"]');
    await views.getByRole("button", { name: "List view", exact: true }).click();
    await expect(
      views.getByRole("button", { name: "List view", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const filters = header.getByRole("button", {
      name: "Filter",
      exact: true,
    });
    const newTask = header.getByRole("button", {
      name: "New task",
      exact: true,
    });
    await expect(filters).toBeVisible();
    const filterBounds = (await filters.boundingBox())!;
    const actionBounds = (await newTask.boundingBox())!;
    expect(filterBounds.x + filterBounds.width).toBeLessThan(actionBounds.x);
    expect(
      Math.abs(
        filterBounds.y +
          filterBounds.height / 2 -
          (actionBounds.y + actionBounds.height / 2),
      ),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("compact-tasks-list.png"),
    });
    await views
      .getByRole("button", { name: "Board view", exact: true })
      .click();
    await expect(
      views.getByRole("button", { name: "Board view", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await header.getByRole("button", { name: "New task", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(filters).toBeInViewport();
    await expect(newTask).toBeInViewport();
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("compact-tasks-mobile.png"),
    });
    await filters.click();
    const filterMenu = page.getByRole("dialog");
    await expect(
      filterMenu.getByRole("option", { name: "Assignee", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(filterMenu).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 720 });
    await sidebar.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(
      header.getByRole("heading", { name: "Organization", exact: true }),
    ).toBeVisible();
    await expect(
      header.getByRole("button", { name: "New task", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('[data-slot="panel-toolbar"]')).toBeHidden();
    expect((await header.boundingBox())?.height).toBe(48);
    await sidebar.getByRole("link", { name: "Members", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${orgSlug}/settings/members$`));
    await expect(
      header.getByRole("heading", { name: "Members", exact: true }),
    ).toBeVisible();
  });

  test("page picker, Blocks, and sidebar chat preserve the selected Preview", async ({
    authedPage: { page, orgSlug },
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const api = page.context().request;
    const previewSite = await startPreviewSite();
    try {
      await page.emulateMedia({ colorScheme: "dark" });
      const owner = uniqueOwner();
      const repo = "layout-preview";
      const project = await createFastPreviewProject(api, orgSlug, {
        owner,
        repo,
        connectionUrl: "http://127.0.0.1:1/unused",
        previewServerUrl: previewSite.url,
      });
      await callSelfMcpTool(api, orgSlug, "COLLECTION_VIRTUAL_MCP_UPDATE", {
        id: project.vmcpId,
        data: { title: "Forma" },
      });
      await seedStubRepo(api, {
        owner,
        repo,
        defaultBranch: "main",
        branches: {
          main: {
            files: {
              ".deco/meta.gen.json": JSON.stringify({
                manifest: {
                  blocks: {
                    sections: {
                      "site/sections/Hero.tsx": { $ref: "#/definitions/Hero" },
                    },
                    pages: {
                      "website/pages/Page.tsx": { $ref: "#/definitions/Page" },
                    },
                  },
                },
                schema: {
                  definitions: {
                    Hero: {
                      type: "object",
                      title: "Hero",
                      properties: {
                        title: { type: "string", title: "Headline" },
                      },
                    },
                    Page: { type: "object", properties: {} },
                  },
                },
              }),
              ".deco/blocks/home.json": JSON.stringify({
                __resolveType: "website/pages/Page.tsx",
                name: "Home page",
                path: "/",
                sections: [
                  {
                    __resolveType: "site/sections/Hero.tsx",
                    title: "Made for everyday living.",
                  },
                ],
              }),
              ".deco/blocks/about.json": JSON.stringify({
                __resolveType: "website/pages/Page.tsx",
                name: "About us",
                path: "/about",
                sections: [
                  {
                    __resolveType: "site/sections/Hero.tsx",
                    title: "Made for everyday living.",
                  },
                ],
              }),
            },
          },
        },
      });
      const thread = await callSelfMcpTool<{ item: { id: string } }>(
        api,
        orgSlug,
        "COLLECTION_THREADS_CREATE",
        { data: { virtual_mcp_id: project.vmcpId, branch: "main" } },
      );
      const path = `/${orgSlug}/projects/${project.vmcpId}/site-editor`;
      await page.goto(`${path}?thread=${thread.item.id}&sidepanel=false`);
      const picker = page.getByTestId("preview-page-picker");
      await expect(picker).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId("preview-blocks-toggle")).toHaveCount(0);
      await expect(
        page
          .getByTestId("page-header")
          .getByRole("heading", { name: "Home page", exact: true }),
      ).toBeVisible();
      await expect(
        page
          .getByTestId("main-panel")
          .getByRole("button", { name: "Open chat", exact: true }),
      ).toHaveCount(0);
      await picker.getByTestId("preview-page-origin").click();
      const search = page.getByPlaceholder("Search pages and components...");
      await expect(search).toBeFocused();
      await search.fill("About");
      await expect(
        page.getByRole("option", { name: /About us/ }),
      ).toBeVisible();
      const option = page.getByRole("option", { name: /About us/ });
      const [optionName, optionPath] = await option.evaluate((element) =>
        ["About us", "/about"].map((text) => {
          const part = Array.from(element.children).find(
            (child) => child.textContent === text,
          )!;
          const { x, y, width, height } = part.getBoundingClientRect();
          return { x, y, width, height };
        }),
      );
      expect(
        Math.abs(
          optionName!.y +
            optionName!.height / 2 -
            optionPath!.y -
            optionPath!.height / 2,
        ),
      ).toBeLessThanOrEqual(1);
      expect(optionPath!.x).toBeGreaterThan(optionName!.x + optionName!.width);
      await search.press("Enter");
      await expect(picker).toContainText("About us");
      await expect(picker).toContainText("/about");
      const pageOrigin = new URL(previewSite.url).origin;
      await expect(picker.getByTestId("preview-page-origin")).toHaveText(
        pageOrigin,
      );
      await expect(picker.getByTestId("preview-page-path")).toHaveText(
        "/about",
      );
      await expect(picker).toHaveAttribute(
        "title",
        `${pageOrigin} · About us · /about`,
      );
      await picker.getByTestId("preview-page-path").click();
      await expect(page.getByRole("dialog")).not.toContainText(
        new URL(previewSite.url).host,
      );
      await expect(option).toHaveAttribute("aria-current", "true");
      await expect(option).toHaveAttribute("aria-selected", "true");
      const otherOption = page.getByRole("option", { name: /Home page/ });
      await otherOption.hover();
      await expect(otherOption).toHaveAttribute("aria-selected", "true");
      await expect(option).toHaveAttribute("aria-current", "true");
      await expect(option).toHaveCSS(
        "background-color",
        await otherOption.evaluate(
          (el) => getComputedStyle(el).backgroundColor,
        ),
      );
      await option.hover();
      await page.screenshot({
        animations: "disabled",
        path: testInfo.outputPath("compact-editor-page-picker.png"),
      });
      await page.keyboard.press("Escape");
      await expect(picker).toBeFocused();
      const originalPicker = await picker.elementHandle();
      await expect(
        page
          .getByTestId("blocks-panel")
          .getByText("Hero", { exact: true })
          .first(),
      ).toBeVisible();
      const originalBlocks = await page
        .getByTestId("blocks-panel")
        .elementHandle();
      await expect(
        page
          .frameLocator('iframe[title="Dev Server Preview"]')
          .getByRole("heading", { name: "Made for everyday living." }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Preview", exact: true }).click();
      expect(await originalPicker!.evaluate((el) => el.isConnected)).toBe(true);
      const sidebar = page.locator('[data-slot="sidebar"]');
      const threadToggle = sidebar.getByRole("button", {
        name: /^(Open|Close) chat$/,
      });
      await page.mouse.move(0, 0);
      await expect(threadToggle).toHaveAttribute("aria-pressed", "false");
      await expect(threadToggle).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      await page.screenshot({
        animations: "disabled",
        path: testInfo.outputPath("compact-editor-expanded.png"),
      });
      const actionDivider = page
        .getByTestId("page-header")
        .locator('[data-slot="separator-root"]')
        .last();
      expect((await actionDivider.boundingBox())?.height).toBe(16);
      const previewDivider = page.locator(
        '[data-slot="panel-toolbar-right"] [data-slot="separator-root"]',
      );
      await expect(previewDivider).toHaveCount(0);
      const width = (await page.getByTestId("main-panel").boundingBox())!.width;
      await sidebar.getByRole("button", { name: "Collapse sidebar" }).click();
      await expect
        .poll(
          async () =>
            (await page.getByTestId("main-panel").boundingBox())!.width,
        )
        .toBeGreaterThan(width + 150);
      await threadToggle.click();
      await expect(page.getByTestId("chat-panel")).toBeVisible();
      await expect(threadToggle).toHaveAttribute("aria-pressed", "true");
      await page.mouse.move(0, 0);
      await expect(threadToggle).not.toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      await expect(picker).toContainText("About us");
      await expect(picker).toContainText("/about");
      expect(await originalBlocks!.evaluate((el) => el.isConnected)).toBe(true);
      expect(await originalPicker!.evaluate((el) => el.isConnected)).toBe(true);
      expect(new URL(page.url()).searchParams.get("thread")).toBe(
        thread.item.id,
      );
      await threadToggle.click();
      await expect(page.getByTestId("chat-panel")).toHaveCount(0);
      await expect(threadToggle).toHaveAttribute("aria-pressed", "false");
      await page.mouse.move(0, 0);
      await expect(threadToggle).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      await threadToggle.click();
      await expect(page.getByTestId("chat-panel")).toBeVisible();
      await expect(threadToggle).toHaveAttribute("aria-pressed", "true");
      await threadToggle.click();
      await expect(page.getByTestId("chat-panel")).toHaveCount(0);
      await expect(threadToggle).toHaveAttribute("aria-pressed", "false");
      await page.mouse.move(0, 0);
      await expect(threadToggle).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      await page.screenshot({
        animations: "disabled",
        path: testInfo.outputPath("compact-editor.png"),
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(picker).toBeVisible();
      const pickerBounds = (await picker.boundingBox())!;
      for (const part of [
        picker.getByTestId("preview-page-origin"),
        picker.getByText("About us", { exact: true }),
        picker.getByTestId("preview-page-path"),
      ]) {
        await expect(part).toBeVisible();
        const partBounds = (await part.boundingBox())!;
        expect(partBounds.x).toBeGreaterThanOrEqual(pickerBounds.x);
        expect(partBounds.x + partBounds.width).toBeLessThanOrEqual(
          pickerBounds.x + pickerBounds.width,
        );
        expect(
          Math.abs(
            partBounds.y +
              partBounds.height / 2 -
              (pickerBounds.y + pickerBounds.height / 2),
          ),
        ).toBeLessThanOrEqual(1);
      }
      await expect(picker).toContainText("About us");
      await expect(picker).toContainText("/about");
      expect(
        await picker.getByText("About us", { exact: true }).evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return range.getClientRects().length;
        }),
      ).toBe(1);
      await expect(page.getByTestId("preview-blocks-toggle")).toHaveCount(0);
      await expect(page.getByTestId("blocks-panel")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Content", exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
      await page.screenshot({
        animations: "disabled",
        path: testInfo.outputPath("compact-editor-mobile.png"),
      });
      await page.setViewportSize({ width: 1280, height: 800 });
      await expect(page.getByTestId("blocks-panel")).toBeVisible();
      await expect(picker).toContainText("About us");
      await expect(picker).toContainText("/about");
    } finally {
      await previewSite.close();
    }
  });

  test("Library shares page actions and filters Documents and Media without losing the folder", async ({
    authedPage: { page, orgSlug },
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const fixtures = [
      {
        name: "Launch notes.md",
        type: "text/markdown",
        content: "# Launch notes\nA quieter workspace.",
      },
      {
        name: "Palette.svg",
        type: "image/svg+xml",
        content:
          '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="265"><rect width="400" height="265" fill="#d2ef6c"/></svg>',
      },
      {
        name: "site.json",
        type: "application/json",
        content: '{"name":"Forma"}',
      },
    ];
    for (const file of fixtures) {
      const response = await page.request.put(
        `/api/${orgSlug}/fs/home/file?path=${encodeURIComponent(`Brand/${file.name}`)}`,
        {
          data: file.content,
          headers: { "content-type": file.type },
        },
      );
      expect(response.ok()).toBe(true);
    }
    await page.goto(`/${orgSlug}/library?path=home%2FBrand`);
    const header = page.getByTestId("page-header");
    await expect(
      header.getByRole("heading", { name: "Brand", exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    const breadcrumbs = header.getByRole("navigation", { name: "Breadcrumbs" });
    await expect(
      breadcrumbs.getByRole("button", { name: "Library", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Brand", { exact: true })).toHaveCount(1);
    await expect(
      header.getByRole("button", { name: "Upload file", exact: true }),
    ).toBeVisible();
    await expect(
      header.getByRole("button", { name: "New folder", exact: true }),
    ).toBeVisible();
    const views = page.locator('[data-slot="page-tabs"]');
    for (const file of fixtures)
      await expect(page.getByText(file.name, { exact: true })).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("compact-library-files.png"),
    });
    await views.getByRole("button", { name: "Documents", exact: true }).click();
    await expect(
      page.getByText("Launch notes.md", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Palette.svg", { exact: true })).toHaveCount(0);
    await expect(page.getByText("site.json", { exact: true })).toHaveCount(0);
    await views.getByRole("button", { name: "Media", exact: true }).click();
    await expect(page.getByText("Palette.svg", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Launch notes.md", { exact: true }),
    ).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("path")).toBe("home/Brand");
    await page.reload();
    await expect(
      views.getByRole("button", { name: "Media", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await header
      .getByRole("button", { name: "Search all files…", exact: true })
      .click();
    const search = page.getByPlaceholder("Search files in Brand…");
    await search.fill("Launch");
    await expect(
      page.getByText('No files match "Launch".', { exact: true }),
    ).toBeVisible();
    await views.getByRole("button", { name: "Documents", exact: true }).click();
    await expect(
      page.getByText("Launch notes.md", { exact: true }),
    ).toBeVisible();
    await search.press("Escape");
    await expect(search).toHaveValue("");
    await header
      .getByRole("button", { name: "New folder", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "New folder", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      header.getByRole("button", { name: "Upload file", exact: true }),
    ).toBeVisible();
    await expect(
      views.getByRole("button", { name: "All files", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("compact-library-mobile.png"),
    });
  });

  test("Library uses one header trail for nested folders and volumes", async ({
    authedPage: { page, orgSlug },
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const folder = "Brand/Launch notes/September 2026";
    for (const volume of ["home", "uploads"]) {
      const response = await page.request.put(
        `/api/${orgSlug}/fs/${volume}/file?path=${encodeURIComponent(`${folder}/Readme.md`)}`,
        {
          data: "# Launch notes",
          headers: { "content-type": "text/markdown" },
        },
      );
      expect(response.ok()).toBe(true);
    }
    const header = page.getByTestId("page-header");
    const breadcrumbs = page.getByRole("navigation", { name: "Breadcrumbs" });
    await page.goto(
      `/${orgSlug}/library?path=${encodeURIComponent(`home/${folder}`)}&fileView=documents`,
    );
    await expect(breadcrumbs).toHaveCount(1);
    // No org crumb on an org page — only inside a project, where it names the
    // project's parent. The folder trail below is the library's own.
    await expect(breadcrumbs.getByRole("link")).toHaveCount(0);
    await expect(
      breadcrumbs.getByRole("heading", { name: "September 2026", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("September 2026", { exact: true })).toHaveCount(
      1,
    );
    await expect(breadcrumbs.locator('[aria-current="page"]')).toHaveCount(1);
    // Five deep is short enough to read in full, so every ancestor is its own
    // button and there is no overflow menu to open.
    await expect(
      breadcrumbs.getByRole("button", { name: "Show navigation path" }),
    ).toHaveCount(0);
    await expect(
      breadcrumbs.getByRole("button", { name: "Brand", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("compact-library-breadcrumbs.png"),
    });

    await breadcrumbs
      .getByRole("button", { name: "Launch notes", exact: true })
      .click();
    await expect(
      header.getByRole("heading", { name: "Launch notes", exact: true }),
    ).toBeVisible();
    expect(new URL(page.url()).searchParams.get("path")).toBe(
      "home/Brand/Launch notes",
    );
    expect(new URL(page.url()).searchParams.get("fileView")).toBe("documents");
    await page.goBack();
    await expect(
      header.getByRole("heading", { name: "September 2026", exact: true }),
    ).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await breadcrumbs
      .getByRole("button", { name: "Show navigation path" })
      .click();
    await expect(page.getByRole("menuitem")).toHaveText([
      "Library",
      "Brand",
      "Launch notes",
    ]);
    await page.getByRole("menuitem", { name: "Brand", exact: true }).click();
    await expect(
      header.getByRole("heading", { name: "Brand", exact: true }),
    ).toBeInViewport();
    expect(new URL(page.url()).searchParams.get("path")).toBe("home/Brand");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await breadcrumbs
      .getByRole("button", { name: "Show navigation path" })
      .click();
    await page.getByRole("menuitem", { name: "Library", exact: true }).click();
    await expect(
      header.getByRole("heading", { name: "Library", exact: true }),
    ).toBeInViewport();
    // Library alone is the whole trail here, so there is nothing to collapse.
    await expect(
      breadcrumbs.getByRole("button", { name: "Show navigation path" }),
    ).toHaveCount(0);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      `/${orgSlug}/library?path=${encodeURIComponent(`uploads/${folder}`)}`,
    );
    await expect(
      header.getByRole("heading", { name: "September 2026", exact: true }),
    ).toBeVisible();
    await breadcrumbs
      .getByRole("button", { name: "Show navigation path" })
      .click();
    await page.getByRole("menuitem", { name: "uploads", exact: true }).click();
    await expect(
      header.getByRole("heading", { name: "uploads", exact: true }),
    ).toBeVisible();
    expect(new URL(page.url()).searchParams.get("path")).toBe("uploads");
    await breadcrumbs
      .getByRole("button", { name: "Library", exact: true })
      .click();
    await expect(
      header.getByRole("heading", { name: "Library", exact: true }),
    ).toBeVisible();
    await expect(breadcrumbs.getByRole("link")).toHaveCount(0);
    await page.goto(`/${orgSlug}/tasks`);
    await expect(
      header.getByRole("heading", { name: "Tasks", exact: true }),
    ).toBeVisible();
    await expect(breadcrumbs.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(breadcrumbs.getByRole("listitem")).toHaveText(["Tasks"]);
  });
});
