/**
 * The board opens on every task, and an assignee filter picked from the UI is
 * what it opens on next time in this browser. A link that names an assignee,
 * or says `any`, still shows what it names.
 */

import type { Page } from "@playwright/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

const card = (page: Page, title: string) =>
  page.locator(`button:has-text("${title}")`);

const assigneeParam = (page: Page) =>
  new URL(page.url()).searchParams.get("assignee");

test("the board reopens on the last assignee filter picked", async ({
  authedPage,
}) => {
  const { page, orgSlug, user } = authedPage;
  const request = page.context().request;
  await callSelfMcpTool(request, orgSlug, "TASK_BOARD_ITEM_CREATE", {
    title: "Mine",
    assigneeId: user.userId,
  });
  await callSelfMcpTool(request, orgSlug, "TASK_BOARD_ITEM_CREATE", {
    title: "Nobody's",
  });
  await page.setViewportSize({ width: 1400, height: 900 });

  await page.goto(`/${orgSlug}/tasks`);
  await expect(card(page, "Mine")).toBeVisible({ timeout: 30_000 });
  await expect(card(page, "Nobody's")).toBeVisible();

  const main = page.getByTestId("main-panel");
  await main.getByRole("button", { name: "Filter" }).click();
  await page.getByRole("option", { name: "Assignee", exact: true }).hover();
  await page
    .locator('[data-slot="popover-content"]')
    .getByText("Unassigned", { exact: true })
    .click();
  await expect(card(page, "Mine")).toBeHidden();

  await page.goto(`/${orgSlug}/tasks`);
  await expect(card(page, "Nobody's")).toBeVisible({ timeout: 30_000 });
  await expect(card(page, "Mine")).toBeHidden();
  expect(assigneeParam(page)).toBeNull();

  await page.goto(`/${orgSlug}/tasks?assignee=any`);
  await expect(card(page, "Mine")).toBeVisible({ timeout: 30_000 });
  await expect(card(page, "Nobody's")).toBeVisible();

  await page.goto(`/${orgSlug}/tasks?assignee=${user.userId}`);
  await expect(card(page, "Mine")).toBeVisible({ timeout: 30_000 });
  await expect(card(page, "Nobody's")).toBeHidden();

  await main.getByRole("button", { name: "Remove Assignee filter" }).click();
  await expect(card(page, "Nobody's")).toBeVisible();
  await expect(card(page, "Mine")).toBeVisible();

  await page.goto(`/${orgSlug}/tasks`);
  await expect(card(page, "Mine")).toBeVisible({ timeout: 30_000 });
  await expect(card(page, "Nobody's")).toBeVisible();
});
