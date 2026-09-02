/** Settings navigation — the two-tier sidebar and the in-page tabs that replaced
 *  the rows it absorbed. Black-box: drives the UI over HTTP and asserts on what
 *  a member sees. Routes are unchanged, so a deep link into a tab still lands on
 *  it with its group's row highlighted. Connect went the other way — its two
 *  tabs merged into one page, so it shows NO strip and carries keys as a
 *  section. */

import { expect, test } from "../fixtures/test";

const SIDEBAR = '[data-slot="sidebar"]';
const SUBNAV = '[data-slot="settings-subnav"]';
const HEADING = '[data-slot="settings-heading"]';

test.describe("settings sidebar", () => {
  test("advanced rows stay collapsed until asked for", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    await page.goto(`/${orgSlug}/settings/general`);

    const sidebar = page.locator(SIDEBAR);
    await expect(sidebar.getByRole("link", { name: "General" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Secrets" })).toHaveCount(0);

    await sidebar.getByRole("button", { name: "Advanced" }).click();

    await expect(sidebar.getByRole("link", { name: "Secrets" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Storage" })).toBeVisible();
  });

  test("a deep link into an advanced row opens the disclosure", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    await page.goto(`/${orgSlug}/settings/buckets`);

    const storage = page.locator(SIDEBAR).getByRole("link", {
      name: "Storage",
    });
    await expect(storage).toBeVisible();
    await expect(storage).toHaveAttribute("data-active", "true");
  });
});

/**
 * One signed-up user for the whole group: Better Auth rate-limits
 * /sign-up/email, and a user per assertion made this file the noisiest
 * signer-upper in the suite.
 */
test.describe("settings tabs", () => {
  test("a merged row stays highlighted while its tabs navigate", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    await page.goto(`/${orgSlug}/settings/roles`);

    const row = page
      .locator(SIDEBAR)
      .getByRole("link", { name: "Members", exact: true });
    await expect(row, "roles lights up Members").toHaveAttribute(
      "data-active",
      "true",
    );

    const tabs = page.locator(SUBNAV);
    await expect(tabs.getByRole("link", { name: "Roles" })).toBeVisible();

    await tabs.getByRole("link", { name: "Members" }).click();
    await expect(page).toHaveURL(new RegExp(`/${orgSlug}/settings/members$`));
    await expect(row).toHaveAttribute("data-active", "true");
  });

  test("connect is one page: no tab strip, API keys inline", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    await page.goto(`/${orgSlug}/settings/connect`);

    await expect(page.locator(HEADING)).toContainText("Connect to clients");
    await expect(page.locator(SUBNAV)).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Connect a client" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();

    const row = page
      .locator(SIDEBAR)
      .getByRole("link", { name: "Connect", exact: true });
    await expect(row).toHaveAttribute("data-active", "true");
  });

  test("the absorbed api-keys route still opens on its own", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    await page.goto(`/${orgSlug}/settings/api-keys`);

    await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();
    await expect(page.locator(SUBNAV)).toHaveCount(0);
    await expect(
      page.locator(SIDEBAR).getByRole("link", { name: "Connect", exact: true }),
    ).toHaveAttribute("data-active", "true");
  });

  test("the heading and tabs stay put while the next tab loads", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    await page.goto(`/${orgSlug}/settings/synced-repos`);

    const tabs = page.locator(SUBNAV);
    await expect(tabs.getByRole("link", { name: "Buckets" })).toBeVisible();

    // Hold the Buckets tab's fetch open so the assertions below land while it
    // is still loading — the whole page used to blank out at this moment.
    await page.route("**/api/*/mcp", async (route) => {
      if (route.request().postData()?.includes("FILE_CONFIG_LIST")) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      await route.continue();
    });

    await tabs.getByRole("link", { name: "Buckets" }).click();

    await expect(page.getByTestId("settings-content-loading")).toBeVisible();
    await expect(page.locator(HEADING)).toContainText("Storage");
    await expect(
      tabs.getByRole("link", { name: "Synced repos" }),
    ).toBeVisible();

    await expect(page.getByTestId("settings-content-loading")).toHaveCount(0, {
      timeout: 15_000,
    });
  });
});
