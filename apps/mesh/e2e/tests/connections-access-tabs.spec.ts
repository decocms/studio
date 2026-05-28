import { signUp } from "../fixtures/auth";
import { SettingsConnectionsPage } from "../pages/settings-connections";
import {
  extractOrgSlugFromUrl,
  test,
  waitForPostSignupRedirect,
} from "../fixtures/test";

test.describe("Connections access tabs", () => {
  test("a new connection appears under Personal but not Shared", async ({
    page,
  }) => {
    await signUp(page);
    await waitForPostSignupRedirect(page);
    const orgSlug = extractOrgSlugFromUrl(page);

    const connections = new SettingsConnectionsPage(page);
    await connections.goto(orgSlug);

    // Create a custom HTTP connection — defaults to access "user" (Personal).
    await connections.openCreateDialog();
    await connections.fillHttpConnection({
      name: "Personal MCP",
      url: "https://personal.example.com/mcp",
    });
    await connections.submit();
    await page.waitForURL(/\/settings\/connections\/.+/, { timeout: 10_000 });

    // Back to the list and check the tabs.
    await connections.goto(orgSlug);

    await connections.clickTab("Personal");
    await connections.expectConnectionVisible("Personal MCP");

    await connections.clickTab("Shared");
    await connections.expectConnectionHidden("Personal MCP");
  });
});
