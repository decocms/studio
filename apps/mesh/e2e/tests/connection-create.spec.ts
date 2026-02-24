import { test, expect } from "@playwright/test";
import { signUp } from "../fixtures/auth";

test.describe("Connection creation flow", () => {
  test("creates an HTTP connection and lands on the detail page", async ({
    page,
  }) => {
    // 1. Sign up — org is auto-created, lands on home page
    await signUp(page);

    // 2. Home page shows the auto-created org. Click it to enter.
    await page.waitForURL("/");
    const orgCard = page
      .getByRole("button")
      .filter({ hasText: /open/i })
      .first();
    await orgCard.waitFor({ state: "visible" });
    await orgCard.click();

    // 3. Lands on /$org or /$org/org-admin — navigate to connections
    await page.waitForURL(/\/[^/]+\/[^/]+/);
    const currentUrl = new URL(page.url());
    const [, orgSlug, projectSlug] = currentUrl.pathname.split("/");
    await page.goto(`/${orgSlug}/${projectSlug}/mcps`);

    // 4. Open the create connection dialog
    await page.getByRole("button", { name: "Custom Connection" }).click();
    await expect(
      page.getByRole("heading", { name: "Create Connection" }),
    ).toBeVisible();

    // 5. The form defaults to HTTP — fill in name and URL
    await page.getByPlaceholder("My Connection").fill("My Test MCP");
    await page
      .getByPlaceholder("https://example.com/mcp")
      .fill("https://example.com/mcp");

    // 6. Submit
    await page
      .getByRole("button", { name: "Create Connection" })
      .last()
      .click();

    // 7. Should navigate to the connection detail page
    await page.waitForURL(/\/mcps\/conn_/, { timeout: 10_000 });
    await expect(page).toHaveURL(/\/mcps\/conn_/);
  });
});
