import { expect, test } from "../fixtures/test";

test.describe("shared application layout", () => {
  test.setTimeout(120_000);

  test("the sidebar stays mounted and preserves its width and collapsed preference across settings", async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${orgSlug}/home`);
    await expect(page.getByTestId("main-panel")).toBeVisible({
      timeout: 90_000,
    });

    const sidebar = page.locator('[data-slot="sidebar"]');
    await expect(sidebar).toHaveAttribute("data-state", "expanded");
    const originalSidebar = await sidebar.elementHandle();
    const originalFrame = await page.locator(".app-shell-root").elementHandle();
    expect(originalSidebar).not.toBeNull();
    expect(originalFrame).not.toBeNull();

    const initialWidth = (await sidebar.boundingBox())!.width;
    const handle = (await page
      .getByRole("separator", { name: "Resize sidebar" })
      .boundingBox())!;
    const startX = handle.x + handle.width / 2;
    await page.mouse.move(startX, handle.y + 200);
    await page.mouse.down();
    await page.mouse.move(startX + 65, handle.y + 200, { steps: 10 });
    await page.mouse.up();
    await expect
      .poll(async () => (await sidebar.boundingBox())!.width)
      .toBeGreaterThan(initialWidth + 40);
    const chosenWidth = (await sidebar.boundingBox())!.width;

    await sidebar.getByRole("button", { name: "Toggle sidebar" }).click();
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");
    await sidebar.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${orgSlug}/settings/general$`));
    await expect(
      page.getByRole("heading", { name: "Organization", exact: true }),
    ).toBeVisible();
    await expect(sidebar).toHaveAttribute("data-state", "expanded");
    await expect
      .poll(async () =>
        Math.abs((await sidebar.boundingBox())!.width - chosenWidth),
      )
      .toBeLessThan(2);
    expect(
      await originalSidebar!.evaluate((element) => element.isConnected),
    ).toBe(true);
    expect(
      await originalFrame!.evaluate((element) => element.isConnected),
    ).toBe(true);

    await sidebar
      .getByRole("link", { name: "Back to home", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/${orgSlug}/home$`));
    await expect(page.getByTestId("main-panel")).toBeVisible();
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");
    expect(
      await originalSidebar!.evaluate((element) => element.isConnected),
    ).toBe(true);
    expect(
      await originalFrame!.evaluate((element) => element.isConnected),
    ).toBe(true);

    await sidebar.getByRole("button", { name: "Toggle sidebar" }).click();
    await expect(sidebar).toHaveAttribute("data-state", "expanded");
    await expect
      .poll(async () =>
        Math.abs((await sidebar.boundingBox())!.width - chosenWidth),
      )
      .toBeLessThan(2);
    await page.reload();
    await expect(page.getByTestId("main-panel")).toBeVisible();
    await expect
      .poll(async () =>
        Math.abs((await sidebar.boundingBox())!.width - chosenWidth),
      )
      .toBeLessThan(2);
  });

  test("a direct mobile settings visit has working shared navigation without starting a thread runtime", async ({
    authedPage: { page, orgSlug },
  }) => {
    const pageErrors: string[] = [];
    const runtimeRequests: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (
        /\/decopilot\/threads\/[^/]+\/(messages|stream)$/.test(path) ||
        path.endsWith("/tools/SANDBOX_START")
      ) {
        runtimeRequests.push(path);
      }
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${orgSlug}/settings/general`);
    await expect(
      page.getByRole("heading", { name: "Organization", exact: true }),
    ).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("chat-panel")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Toggle sidebar", exact: true }),
    ).toHaveCount(1);

    const navigation = page.getByRole("dialog", {
      name: "Navigation",
      exact: true,
    });
    await page
      .getByRole("button", { name: "Toggle sidebar", exact: true })
      .click();
    await expect(navigation).toBeVisible();
    await expect(
      navigation.getByRole("link", { name: "General", exact: true }),
    ).toBeVisible();
    expect(runtimeRequests).toEqual([]);
    expect(pageErrors).toEqual([]);

    await navigation
      .getByRole("link", { name: "Back to home", exact: true })
      .click();
    await expect(navigation).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/${orgSlug}/home$`));
    await expect(
      page.getByRole("button", { name: "Switch to Chat", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Toggle sidebar", exact: true }),
    ).toHaveCount(1);

    await page
      .getByRole("button", { name: "Toggle sidebar", exact: true })
      .click();
    await navigation
      .getByRole("link", { name: "Settings", exact: true })
      .click();
    await expect(navigation).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "Organization", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Switch to Chat", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Toggle sidebar", exact: true }),
    ).toHaveCount(1);
    expect(pageErrors).toEqual([]);
  });
});
