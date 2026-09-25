import { expect, test } from "../fixtures/test";

for (const savedPreference of [undefined, false, true, "true"]) {
  test(`the default layout is independent of the editor preference (${savedPreference})`, async ({
    authedPage: { page, orgSlug },
  }) => {
    await page.addInitScript((compactPageLayout) => {
      localStorage.setItem(
        "studio:user:preferences",
        JSON.stringify({
          theme: "dark",
          enableSounds: true,
          compactPageLayout,
        }),
      );
    }, savedPreference);
    await page.goto(`/${orgSlug}/settings/profile`);
    const toggle = page.getByRole("switch", {
      name: "New blocks editor",
      exact: true,
    });
    await expect(toggle).toHaveAttribute(
      "aria-checked",
      String(savedPreference === true),
      { timeout: 60_000 },
    );
    await expect(page.getByTestId("page-header")).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(
      page.getByRole("switch", { name: "New Layout", exact: true }),
    ).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute(
      "aria-checked",
      String(savedPreference !== true),
    );
    await expect(page.getByTestId("page-header")).toBeVisible();
    await page.goto(`/${orgSlug}/library`);
    await expect(page.getByTestId("page-header")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Documents", exact: true }),
    ).toBeVisible();
  });
}

test("the editor opt-in persists without changing the application layout", async ({
  authedPage: { page, orgSlug },
}) => {
  await page.goto(`/${orgSlug}/settings/profile`);
  const toggle = page.getByRole("switch", {
    name: "New blocks editor",
    exact: true,
  });
  await expect(toggle).not.toBeChecked({ timeout: 60_000 });
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.reload();
  await expect(toggle).toBeChecked();
  await expect(page.getByTestId("page-header")).toBeVisible();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await page.reload();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByTestId("page-header")).toBeVisible();
});
