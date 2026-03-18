import { test, expect } from "@playwright/test";
import { signUp } from "../fixtures/auth";

test.describe("Connection creation flow", () => {
  test("creates an HTTP connection and lands on the detail page", async ({
    page,
  }) => {
    // 1. Sign up — org is auto-created, lands on home page
    await signUp(page);

    // 2. Wait for the auto-redirect to the org-admin page and extract slug from URL
    await page.waitForURL(/\/[a-z0-9-]+\/org-admin/, { timeout: 15_000 });
    const orgSlug = new URL(page.url()).pathname.split("/")[1];

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

    // 7. Should navigate to the connection detail page (slug derived from URL)
    await page.waitForURL(/\/mcps\/examplecom-mcp/, { timeout: 10_000 });
    await expect(page).toHaveURL(/\/mcps\/examplecom-mcp/);
  });
});
