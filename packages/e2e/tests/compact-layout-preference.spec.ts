import { expect, test } from "../fixtures/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";

test("compact layout is opt-in, persists, and can be turned off", async ({
  authedPage: { page, orgSlug },
}, testInfo) => {
  test.setTimeout(120_000);
  await page.goto(`/${orgSlug}/settings/profile`);
  const toggle = page.getByRole("switch", {
    name: "Compact layout (preview)",
    exact: true,
  });
  const row = page.getByRole("button", { name: /^Compact layout \(preview\)/ });
  await expect(toggle).not.toBeChecked({ timeout: 60_000 });
  await expect(
    page.getByText("Project settings shortcut", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId("page-header")).toHaveCount(0);
  await expect(
    page
      .locator('[data-slot="page-content"]')
      .getByRole("heading", { name: "Profile & Preferences", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("compact-preference-off.png"),
  });

  const sounds = page.getByRole("button", { name: /^Sounds\b/ });
  await expect(sounds.getByRole("switch")).not.toBeChecked();
  await sounds
    .getByRole("button", { name: "Preview notification sound", exact: true })
    .press("Space");
  await expect(sounds.getByRole("switch")).not.toBeChecked();
  await sounds.hover();
  const hoverBackground = await sounds.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await row.hover();
  await expect(row).toHaveCSS("cursor", "pointer");
  await expect(row).toHaveCSS("background-color", hoverBackground);
  await row.getByText("Compact layout (preview)", { exact: true }).click();
  await expect(toggle).toBeChecked();
  await toggle.press("Space");
  await expect(toggle).not.toBeChecked();
  await toggle.press("Enter");
  await expect(toggle).toBeChecked();
  await row.press("Space");
  await expect(toggle).not.toBeChecked();
  await row.press("Enter");
  await expect(toggle).toBeChecked();
  await expect(
    page
      .getByTestId("page-header")
      .getByRole("heading", { name: "Profile & Preferences", exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute(
    "data-compact-layout",
    "true",
  );
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("compact-preference-on.png"),
  });
  await page.reload();
  await expect(toggle).toBeChecked();

  await callSelfMcpTool(page.request, orgSlug, "TASK_BOARD_ITEM_CREATE", {
    title: "Layout preference task",
  });
  await page.goto(`/${orgSlug}/tasks`);
  await expect(
    page
      .getByTestId("page-header")
      .getByRole("button", { name: "New task", exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  const newTask = page.getByRole("button", { name: "New task", exact: true });
  await expect(newTask).toHaveCSS("border-radius", "9999px");
  await page.goto(`/${orgSlug}/library`);
  await expect(page.locator('[data-slot="panel-toolbar"]')).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.getByRole("button", { name: "Documents", exact: true }),
  ).toBeVisible();

  await page.goto(`/${orgSlug}/settings/profile`);
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByTestId("page-header")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute(
    "data-compact-layout",
    "false",
  );
  await page.reload();
  await expect(toggle).not.toBeChecked();
  await page.goto(`/${orgSlug}/tasks`);
  await expect(
    page.getByRole("button", { name: "New task", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("page-header")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Assignee", exact: true }),
  ).toBeVisible();
  await expect(newTask).not.toHaveCSS("border-radius", "9999px");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  const filters = page.getByRole("dialog", { name: "Filters", exact: true });
  await expect(
    filters.getByRole("button", { name: "Assignee", exact: true }),
  ).toBeVisible();
  await filters.getByRole("button", { name: "Done", exact: true }).click();
  await expect(filters).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`/${orgSlug}/library`);
  await expect(
    page.getByRole("button", { name: "Upload file", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Documents", exact: true }),
  ).toHaveCount(0);
});

test("classic project settings keep edits when opting in and back out", async ({
  authedPage: { page, orgSlug },
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const { item: project } = await callSelfMcpTool<{ item: { id: string } }>(
    page.request,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    { data: { title: "Classic project", status: "active", connections: [] } },
  );
  const settingsPath = `/${orgSlug}/projects/${project.id}/settings`;
  await page.goto(settingsPath);
  const name = page.getByPlaceholder("Project name", { exact: true });
  await expect(name).toHaveValue("Classic project", { timeout: 60_000 });
  await expect(page.getByTestId("page-header")).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Project settings sections" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /^Site and sandbox/ }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("classic-project-settings.png"),
  });
  await name.fill("Saved project");
  await page.getByRole("button", { name: /^General\b/ }).click();
  await expect(page).toHaveURL(/section=general/);
  await page
    .locator('[data-slot="page-content"]')
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await expect(name).toHaveValue("Saved project");
  await expect
    .poll(
      async () => {
        const { item } = await callSelfMcpTool<{ item: { title: string } }>(
          page.request,
          orgSlug,
          "COLLECTION_VIRTUAL_MCP_GET",
          { id: project.id },
        );
        return item.title;
      },
      { timeout: 15_000 },
    )
    .toBe("Saved project");

  for (const enabled of [true, false]) {
    await page.goto(`/${orgSlug}/settings/profile`);
    const toggle = page.getByRole("switch", {
      name: "Compact layout (preview)",
      exact: true,
    });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", String(enabled));
    await page.goto(settingsPath);
    if (enabled) {
      await expect(
        page.getByRole("textbox", { name: "Project name", exact: true }),
      ).toHaveValue("Saved project");
      await expect(
        page.getByRole("navigation", { name: "Project settings sections" }),
      ).toBeVisible();
    } else {
      await expect(name).toHaveValue("Saved project");
      await expect(page.getByTestId("page-header")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: /^Site and sandbox/ }),
      ).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(
        page.getByRole("button", { name: /^General\b/ }),
      ).toBeInViewport();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
      await page.screenshot({
        path: testInfo.outputPath("classic-project-settings-mobile.png"),
      });
    }
  }
});

test("existing preferences keep their values and an invalid layout preference stays off", async ({
  authedPage: { page, orgSlug },
}) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    localStorage.setItem(
      "studio:user:preferences",
      JSON.stringify({
        theme: "dark",
        language: "pt-BR",
        enableSounds: true,
        compactPageLayout: "true",
        showProjectSettingsGear: true,
      }),
    );
  });
  await page.goto(`/${orgSlug}/settings/profile`);
  await expect(
    page.getByRole("switch", { name: "Layout compacto (prévia)", exact: true }),
  ).not.toBeChecked({ timeout: 60_000 });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByTestId("page-header")).toHaveCount(0);
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("studio:user:preferences") ?? "{}"),
  );
  expect(saved).toMatchObject({
    theme: "dark",
    language: "pt-BR",
    enableSounds: true,
    compactPageLayout: false,
  });
  expect(saved).not.toHaveProperty("showProjectSettingsGear");
});
