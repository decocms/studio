/**
 * Settings navigation — the two-tier sidebar and the in-page tabs that replaced
 * the rows it absorbed.
 *
 * Black-box: drives the UI over HTTP and asserts on what a member sees. The
 * routes themselves are unchanged, so a deep link into a tab must still land on
 * that tab with its group's sidebar row highlighted.
 */

import { expect, test } from "../fixtures/test";

const SIDEBAR = '[data-slot="sidebar"]';
const SUBNAV = '[data-slot="settings-subnav"]';

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

    const cases = [
      {
        row: "Members",
        deepLink: "roles",
        otherTab: "Roles",
        clickTab: "Members",
        lands: "members",
      },
      {
        row: "Connect",
        deepLink: "connect",
        otherTab: "Clients",
        clickTab: "API Keys",
        lands: "api-keys",
      },
    ];

    for (const c of cases) {
      await page.goto(`/${orgSlug}/settings/${c.deepLink}`);

      const row = page
        .locator(SIDEBAR)
        .getByRole("link", { name: c.row, exact: true });
      await expect(row, `${c.deepLink} lights up ${c.row}`).toHaveAttribute(
        "data-active",
        "true",
      );

      const tabs = page.locator(SUBNAV);
      await expect(tabs.getByRole("link", { name: c.otherTab })).toBeVisible();

      await tabs.getByRole("link", { name: c.clickTab }).click();
      await expect(page).toHaveURL(
        new RegExp(`/${orgSlug}/settings/${c.lands}$`),
      );
      await expect(row).toHaveAttribute("data-active", "true");
    }
  });
});
