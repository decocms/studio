import { test, expect } from "@playwright/test";
import { signUp } from "../fixtures/auth";

test.describe("Connection creation flow", () => {
  test("creates an HTTP connection and lands on the detail page", async ({
    page,
  }) => {
    // 1. Sign up — org is auto-created, lands on home page
    await signUp(page);

    // 2. Wait for home page and extract the org slug from the card (@slug text)
    await page.waitForURL("/");
    const slugText = page.locator("text=/@[a-z0-9-]+/").first();
    await slugText.waitFor({ state: "visible" });
    const rawSlug = await slugText.textContent();
    const orgSlug = rawSlug?.replace("@", "").trim() ?? "";

    // 3. Navigate directly to the connections page (org-admin is the default project)
    await page.goto(`/${orgSlug}/org-admin/mcps`);

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
