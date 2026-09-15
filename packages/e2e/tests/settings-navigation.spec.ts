/** Settings navigation — the two-tier sidebar and the in-page tabs that replaced
 *  the rows it absorbed. Black-box: drives the UI over HTTP and asserts on what
 *  a member sees. Routes are unchanged, so a deep link into a tab still lands on
 *  it with its group's row highlighted. Connect went the other way — its two
 *  tabs merged into one page, so it shows NO strip and carries keys as a
 *  section. */

import { sleep } from "@decocms/shared/std";
import { expect, test } from "../fixtures/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";

const SIDEBAR = '[data-slot="sidebar"]';
const SUBNAV = '[data-slot="settings-subnav"]';
const TOPBAR_LEFT = '[data-slot="main-topbar-left"]';
const TOPBAR_RIGHT = '[data-slot="main-topbar-right"]';
const MAIN_CONTENT = '[data-slot="main-content"]';
const SHELL_TIMEOUT_MS = 60_000;

test.describe("settings sidebar", () => {
  test("advanced rows stay collapsed until asked for", async ({
    authedPage,
  }) => {
    // Signup, the first org public-set sync, and cold route compilation may
    // share one local dev-server event loop with three other E2E workers.
    test.slow();
    const { page, orgSlug } = authedPage;
    await page.goto(`/${orgSlug}/settings/general`);

    const sidebar = page.locator(SIDEBAR);
    await expect(sidebar).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await expect(sidebar.getByRole("link", { name: "General" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Secrets" })).toHaveCount(0);

    await sidebar.getByRole("button", { name: "Advanced" }).click();

    await expect(sidebar.getByRole("link", { name: "Secrets" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Storage" })).toBeVisible();
  });

  test("a deep link into an advanced row opens the disclosure", async ({
    authedPage,
  }) => {
    test.slow();
    const { page, orgSlug } = authedPage;
    await page.goto(`/${orgSlug}/settings/buckets`);

    const sidebar = page.locator(SIDEBAR);
    await expect(sidebar).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    const storage = sidebar.getByRole("link", {
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
  test("storage create actions stay in the topbar at compact widths", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    await page.setViewportSize({ width: 320, height: 720 });

    await page.goto(`/${orgSlug}/settings/buckets`);

    const addBucket = page
      .locator(TOPBAR_RIGHT)
      .getByRole("button", { name: "Add bucket", exact: true });
    await expect(addBucket).toBeVisible();
    await expect(
      page
        .locator(MAIN_CONTENT)
        .getByRole("button", { name: "Add bucket", exact: true }),
      "an empty page keeps its contextual shortcut",
    ).toBeVisible();
    expect(
      await addBucket.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= window.innerWidth;
      }),
      "the compact topbar action is not clipped",
    ).toBe(true);

    await callSelfMcpTool(api, orgSlug, "FILE_CONFIG_CREATE", {
      name: `settings-nav-${Date.now()}`,
      bucket: "settings-navigation",
      region: "us-east-1",
      credentialType: "static",
      accessKeyId: "e2e-access-key",
      secretAccessKey: "e2e-secret-key",
    });
    await page.reload();

    await expect(addBucket).toBeVisible();
    await expect(
      page
        .locator(MAIN_CONTENT)
        .getByRole("button", { name: "Add bucket", exact: true }),
      "a populated page has no duplicate content action",
    ).toHaveCount(0);

    await page.goto(`/${orgSlug}/settings/synced-repos`);

    const addRepo = page
      .locator(TOPBAR_RIGHT)
      .getByRole("button", { name: "Add repo", exact: true });
    await expect(addRepo).toBeVisible();
    await expect(
      page
        .locator(MAIN_CONTENT)
        .getByRole("button", { name: "Add repo", exact: true }),
      "an empty page keeps its contextual shortcut",
    ).toBeVisible();
    expect(
      await addRepo.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= window.innerWidth;
      }),
      "the compact topbar action is not clipped",
    ).toBe(true);

    const { item: repoConnection } = await callSelfMcpTool<{
      item: { id: string };
    }>(api, orgSlug, "COLLECTION_CONNECTIONS_CREATE", {
      data: {
        title: `GitHub: settings navigation ${Date.now()}`,
        app_name: "mcp-github",
        connection_type: "HTTP",
        connection_url: "https://example.com/mcp",
        metadata: {
          repoScope: {
            installationId: 1,
            repositoryId: 99,
            owner: "acme",
            repo: "widget",
            permissions: { contents: "read" },
          },
        },
      },
    });
    await callSelfMcpTool(api, orgSlug, "ORG_REPO_SYNC_CREATE", {
      connectionId: repoConnection.id,
      volume: `settings-nav-${Date.now()}`,
    });
    await page.reload();

    await expect(addRepo).toBeVisible();
    await expect(
      page
        .locator(MAIN_CONTENT)
        .getByRole("button", { name: "Add repo", exact: true }),
      "a populated page has no duplicate content action",
    ).toHaveCount(0);
  });

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

    await expect(
      page.locator(TOPBAR_LEFT).getByRole("heading", {
        level: 1,
        name: "Connect",
        exact: true,
      }),
    ).toBeVisible();
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

    await expect(
      page.locator(TOPBAR_LEFT).getByRole("heading", {
        level: 1,
        name: "API keys",
        exact: true,
      }),
    ).toBeVisible();
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
        await sleep(3000);
      }
      await route.continue();
    });

    await tabs.getByRole("link", { name: "Buckets" }).click();

    await expect(page.getByTestId("settings-content-loading")).toBeVisible();
    await expect(
      page.locator(TOPBAR_LEFT).getByRole("heading", {
        level: 1,
        name: "Buckets",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      tabs.getByRole("link", { name: "Synced repos" }),
    ).toBeVisible();

    await expect(page.getByTestId("settings-content-loading")).toHaveCount(0, {
      timeout: 15_000,
    });
  });
});
