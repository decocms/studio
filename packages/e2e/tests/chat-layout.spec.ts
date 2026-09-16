import { expect, test } from "../fixtures/test";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";

test.describe("chat layout composition", () => {
  test.setTimeout(120_000);

  test("resizing and collapsing preserve the page and the chosen split", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const request = page.context().request;
    const connection = await createHttpConnection(request, orgSlug, {
      title: "Layout fixture",
      url: "http://127.0.0.1:1/unused",
    });
    const project = await callSelfMcpTool<{ item: { id: string } }>(
      request,
      orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      {
        data: {
          title: "Layout project",
          status: "active",
          connections: [{ connection_id: connection.id }],
        },
      },
    );
    const path = `/${orgSlug}/projects/${project.item.id}/settings`;
    await callSelfMcpTool(request, orgSlug, "COLLECTION_VIRTUAL_MCP_CREATE", {
      data: {
        title: "Layout development project",
        status: "active",
        connections: [{ connection_id: connection.id }],
        metadata: { liveAgentId: project.item.id },
      },
    });
    await page.goto(`${path}?sidepanel=true`);
    const input = page.getByPlaceholder("Project name");
    await expect(input).toBeVisible({ timeout: 90_000 });
    const originalInput = await input.elementHandle();
    expect(originalInput).not.toBeNull();
    // Project switching belongs on Settings too; only publish controls are editor-specific.
    await expect(
      page.getByRole("button", { name: "Develop", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Live", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");

    const layout = page.locator('[data-slot="chat-layout"]');
    const chat = page.getByTestId("chat-layout-thread");
    const separator = layout.getByRole("separator");
    const initialWidth = (await chat.boundingBox())!.width;
    const handle = (await separator.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 200);
    await page.mouse.down();
    await page.mouse.move(handle.x + 100, handle.y + 200, { steps: 10 });
    await page.mouse.up();
    await expect
      .poll(async () => (await chat.boundingBox())!.width)
      .toBeGreaterThan(initialWidth + 50);
    const resizedWidth = (await chat.boundingBox())!.width;

    const sidebar = page.locator('[data-slot="sidebar"]');
    await expect(
      sidebar.getByRole("button", { name: "Close chat", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page
        .getByTestId("side-panel")
        .getByRole("button", { name: "Close chat", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("compact-chat-header.png"),
    });
    await sidebar
      .getByRole("button", { name: "Close chat", exact: true })
      .click();
    await expect(page.getByTestId("chat-panel")).toHaveCount(0);
    await page.getByRole("button", { name: "Open chat", exact: true }).click();
    await expect(page.getByTestId("chat-panel")).toBeVisible();
    await expect
      .poll(async () =>
        Math.abs((await chat.boundingBox())!.width - resizedWidth),
      )
      .toBeLessThan(2);

    await page.getByRole("button", { name: "Hide panel", exact: true }).click();
    await expect(page.getByTestId("main-panel")).toBeHidden();
    await page.getByRole("button", { name: "Show panel", exact: true }).click();
    await expect(input).toBeVisible();
    expect(
      await originalInput!.evaluate((element) => element.isConnected),
    ).toBe(true);
    expect(new URL(page.url()).pathname).toBe(path);

    await page
      .getByRole("navigation", { name: "Project settings sections" })
      .getByRole("link", { name: "Project layout", exact: true })
      .click();
    await page.getByRole("button", { name: /^Automations\b/ }).click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === `/${orgSlug}/projects/${project.item.id}/automations`,
    );
    await expect(page.getByTestId("main-panel")).toBeVisible();
    await expect
      .poll(async () =>
        Math.abs((await chat.boundingBox())!.width - resizedWidth),
      )
      .toBeLessThan(2);
    await sidebar
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await expect(input).toBeVisible();
    await expect
      .poll(async () =>
        Math.abs((await chat.boundingBox())!.width - resizedWidth),
      )
      .toBeLessThan(2);

    await page.reload();
    await expect(input).toBeVisible();
    await expect
      .poll(async () =>
        Math.abs((await chat.boundingBox())!.width - resizedWidth),
      )
      .toBeLessThan(2);
  });

  test("invalid route search preserves the split and navigation can recover", async ({
    authedPage: { page, orgSlug },
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    const request = page.context().request;
    const connection = await createHttpConnection(request, orgSlug, {
      title: "Route error fixture",
      url: "http://127.0.0.1:1/unused",
    });
    const project = await callSelfMcpTool<{ item: { id: string } }>(
      request,
      orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      {
        data: {
          title: "Route error project",
          status: "active",
          connections: [{ connection_id: connection.id }],
        },
      },
    );

    await page.goto(
      `/${orgSlug}/projects/${project.item.id}/automations/invalid?automationView=invalid&sidepanel=true`,
    );
    const panel = page.getByTestId("main-panel");
    await expect(panel.getByRole("button", { name: "Try again" })).toBeVisible({
      timeout: 90_000,
    });
    await expect(page.getByTestId("chat-panel")).toBeVisible();
    await expect(
      page
        .getByTestId("page-header")
        .getByRole("heading", { name: "Automations", exact: true }),
    ).toBeVisible();
    expect(pageErrors).toEqual([]);

    await page
      .locator('[data-slot="sidebar"]')
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === `/${orgSlug}/projects/${project.item.id}/settings`,
    );
    await expect(page.getByPlaceholder("Project name")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Try again" })).toHaveCount(
      0,
    );
    await expect(page.getByTestId("chat-panel")).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test("the mobile topbar keeps one working surface switch across viewport changes", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${orgSlug}/home`);
    const toggle = page.getByRole("button", {
      name: "Toggle sidebar",
      exact: true,
    });
    await expect(page.getByTestId("page-header")).toBeVisible({
      timeout: 90_000,
    });
    for (const width of [1440, 390, 1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      if (width > 768) await expect(toggle).toBeHidden();
      else await expect(toggle).toBeVisible();
      await expect(
        page.locator('[data-testid="page-header"]:visible'),
      ).toHaveCount(1);
    }
    const topbar = page.locator('[data-slot="panel-topbar"]:visible');
    await expect(topbar).toHaveCount(1);
    await expect(topbar).toHaveCSS("position", "relative");
    await expect(topbar).toHaveCSS("z-index", "10");
    const headerBounds = (await topbar.boundingBox())!;
    const bodyBounds = (await page
      .getByTestId("main-panel")
      .locator('[data-slot="panel-content"]')
      .boundingBox())!;
    expect(bodyBounds.y).toBeGreaterThanOrEqual(
      headerBounds.y + headerBounds.height,
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);

    await toggle.click();
    await page
      .getByRole("dialog", { name: "Navigation", exact: true })
      .getByRole("button", { name: "Open chat", exact: true })
      .click();
    await expect(page.getByTestId("chat-panel")).toBeVisible();
    await expect(page.getByTestId("main-panel")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Switch to Main view", exact: true })
      .click();
    await expect(page.getByTestId("main-panel")).toBeVisible();
    await expect(page.getByTestId("chat-panel")).toHaveCount(0);
    await expect(toggle).toBeVisible();
    const navigation = page.getByRole("dialog", {
      name: "Navigation",
      exact: true,
    });
    await toggle.click();
    await expect(
      navigation.getByRole("button", { name: "Open chat", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    await navigation
      .getByRole("button", { name: "Open chat", exact: true })
      .click();
    await expect(page.getByTestId("chat-panel")).toBeVisible();
    await toggle.click();
    const closeThread = navigation.getByRole("button", {
      name: "Close chat",
      exact: true,
    });
    await expect(closeThread).toHaveAttribute("aria-pressed", "true");
    await expect(closeThread).not.toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await closeThread.click();
    await expect(navigation).toBeHidden();
    await expect(page.getByTestId("chat-panel")).toHaveCount(0);
    await expect(page.getByTestId("main-panel")).toBeVisible();
  });

  test("settings content scrolls inside the panel while the sidebar stays fixed", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto(`/${orgSlug}/settings/profile`);
    const panel = page.getByTestId("settings-panel");
    const content = panel.locator('[data-slot="page-content"]');
    await expect(content).toBeVisible({ timeout: 90_000 });
    await expect(panel.getByRole("heading", { level: 1 })).toBeVisible();
    const sidebar = page.locator('[data-slot="sidebar"]');
    const sidebarBounds = await sidebar.boundingBox();
    await content.hover();
    await page.mouse.wheel(0, 700);
    await expect
      .poll(() => content.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await sidebar.boundingBox()).toEqual(sidebarBounds);
  });
});
