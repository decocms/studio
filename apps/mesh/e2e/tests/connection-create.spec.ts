import { signUp } from "../fixtures/auth";
import { SettingsConnectionsPage } from "../pages/settings-connections";
import {
  expect,
  extractOrgSlugFromUrl,
  test,
  waitForPostSignupRedirect,
} from "../fixtures/test";

test.describe("Connection creation flow", () => {
  test("creates an HTTP connection and lands on the detail page", async ({
    page,
  }) => {
    await signUp(page);
    await waitForPostSignupRedirect(page);
    const orgSlug = extractOrgSlugFromUrl(page);

    const connections = new SettingsConnectionsPage(page);
    await connections.goto(orgSlug);
    await connections.openCreateDialog();
    await connections.fillHttpConnection({
      name: "My Test MCP",
      url: "https://example.com/mcp",
    });
    await connections.submit();

    // Slug derived server-side from the URL: example.com/mcp → examplecom-mcp.
    await page.waitForURL(/\/settings\/connections\/examplecom-mcp/, {
      timeout: 10_000,
    });
    await expect(page).toHaveURL(/\/settings\/connections\/examplecom-mcp/);
  });
});
