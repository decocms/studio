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

test.describe("settings tabs", () => {
  test("roles is a tab of members, and keeps members highlighted", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    await page.goto(`/${orgSlug}/settings/roles`);

    const members = page
      .locator(SIDEBAR)
      .getByRole("link", { name: "Members" });
    await expect(members).toHaveAttribute("data-active", "true");

    const tabs = page.locator(SUBNAV);
    await expect(tabs.getByRole("link", { name: "Roles" })).toBeVisible();

    await tabs.getByRole("link", { name: "Members" }).click();
    await expect(page).toHaveURL(new RegExp(`/${orgSlug}/settings/members$`));
    await expect(members).toHaveAttribute("data-active", "true");
  });

  test("ai providers is a tab of billing", async ({ authedPage }) => {
    const { page, orgSlug } = authedPage;
    await page.goto(`/${orgSlug}/settings/ai-providers`);

    const billing = page
      .locator(SIDEBAR)
      .getByRole("link", { name: "Billing" });
    await expect(billing).toHaveAttribute("data-active", "true");

    await page
      .locator(SUBNAV)
      .getByRole("link", { name: "Plan & usage" })
      .click();
    await expect(page).toHaveURL(new RegExp(`/${orgSlug}/settings/billing$`));
    await expect(billing).toHaveAttribute("data-active", "true");
  });

  test("api keys is a tab of connect", async ({ authedPage }) => {
    const { page, orgSlug } = authedPage;
    await page.goto(`/${orgSlug}/settings/connect`);

    const connect = page
      .locator(SIDEBAR)
      .getByRole("link", { name: "Connect", exact: true });
    await expect(connect).toHaveAttribute("data-active", "true");

    await page.locator(SUBNAV).getByRole("link", { name: "API Keys" }).click();
    await expect(page).toHaveURL(new RegExp(`/${orgSlug}/settings/api-keys$`));
    await expect(connect).toHaveAttribute("data-active", "true");
  });
});
