/**
 * The task detail's "More actions" menu (`/$org/tasks` → card → ⋯).
 *
 * Opening a card is a navigation, not a modal: the card owns the path
 * `/$org/tasks/DECO-01`, which renders it in place of the lanes, and the
 * breadcrumb leads back out to the bare board. These tests pin that contract
 * at both ends — the URL a card click produces, and the fact that a menu item
 * which destroys the card lands you back on a working board.
 *
 * The inherited guard is still here on purpose: when Delete/Archive lived in a
 * dialog, picking one tore two overlapping Radix layers down in the same tick
 * and left `pointer-events: none` on <body> with no layer to restore it. The
 * board kept updating over SSE but the whole app stopped taking clicks. The
 * page chrome removes one of those layers; the assertion stays because the
 * menu is still a Radix layer and the failure is invisible to a unit test.
 */

import type { APIRequestContext, Page } from "@playwright/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

// Black-box wire-contract shape (owned by this test, per e2e isolation rules).
interface ListedItem {
  title: string;
  status: string;
}

async function seedCards(
  request: APIRequestContext,
  orgSlug: string,
  count: number,
) {
  for (let i = 0; i < count; i++) {
    await callSelfMcpTool(request, orgSlug, "TASK_BOARD_ITEM_CREATE", {
      title: `Card ${i}`,
    });
  }
}

async function openBoard(page: Page, orgSlug: string) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/${orgSlug}/tasks`);
  // Generous: the board's first paint waits on the shell's route chunks.
  await expect(page.locator('button:has-text("Card 0")')).toBeVisible({
    timeout: 30_000,
  });
}

const detail = (page: Page) => page.getByTestId("task-detail");

/** A card's own URL: the board's path plus the human key it wears. */
const cardUrl = (orgSlug: string) => new RegExp(`/${orgSlug}/tasks/[^/?#]+`);

test("clicking a card navigates to it and the breadcrumb comes back", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  await seedCards(page.context().request, orgSlug, 2);
  await openBoard(page, orgSlug);

  await page.locator('button:has-text("Card 1")').click();
  await expect(detail(page)).toBeVisible();
  await expect(detail(page)).toContainText("Card 1");
  // The address a shared link carries is a path segment now, never `?task=`.
  await expect(page).toHaveURL(cardUrl(orgSlug));
  await expect(page).not.toHaveURL(/[?&]task=/);
  // The lanes are out of view while the task holds the panel.
  await expect(page.locator('button:has-text("Card 0")')).toBeHidden();

  await detail(page).getByRole("button", { name: "Tasks" }).click();
  await expect(detail(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(cardUrl(orgSlug));
  await expect(page.locator('button:has-text("Card 0")')).toBeVisible();
});

test("browser back returns to the board", async ({ authedPage }) => {
  const { page, orgSlug } = authedPage;
  await seedCards(page.context().request, orgSlug, 1);
  await openBoard(page, orgSlug);

  await page.locator('button:has-text("Card 0")').click();
  await expect(detail(page)).toBeVisible();

  // Pushed, not replaced: the board is still the previous history entry.
  await page.goBack();
  await expect(detail(page)).toHaveCount(0);
  await expect(page.locator('button:has-text("Card 0")')).toBeVisible();
});

test("closing a task does not leave it one Back away", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  await seedCards(page.context().request, orgSlug, 1);
  await openBoard(page, orgSlug);

  const depth = () => page.evaluate(() => history.length);
  const atBoard = await depth();

  await page.locator('button:has-text("Card 0")').click();
  await expect(detail(page)).toBeVisible();
  expect(await depth()).toBe(atBoard + 1);

  /* Leaving replaces the task's entry instead of stacking a second one: if it
     pushed, Back would re-open the task just closed, and a few open/close
     cycles would bury whatever the board was reached from. */
  await detail(page).getByRole("button", { name: "Tasks" }).click();
  await expect(detail(page)).toHaveCount(0);
  expect(await depth()).toBe(atBoard + 1);

  await page.goBack();
  await expect(detail(page)).toHaveCount(0);
});

/** Every item in this menu leaves the detail the same way, so the two that
 *  change the board prove the whole menu. */
for (const action of ["Delete", "Archive"] as const) {
  test(`${action} from the detail menu leaves the app clickable`, async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    await seedCards(request, orgSlug, 2);
    await openBoard(page, orgSlug);

    await page.locator('button:has-text("Card 1")').click();
    await expect(detail(page)).toBeVisible();
    await detail(page).getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: action }).click();

    // The card is gone, and so is the page that was showing it.
    await expect(detail(page)).toHaveCount(0);
    await expect(page.locator('button:has-text("Card 1")')).toHaveCount(0);
    await expect
      .poll(() =>
        callSelfMcpTool<{ items: ListedItem[] }>(
          request,
          orgSlug,
          "TASK_BOARD_ITEM_LIST",
          {},
        ).then(({ items }) =>
          items.map((i) => `${i.title}:${i.status}`).sort(),
        ),
      )
      .toEqual(
        action === "Delete"
          ? ["Card 0:triage"]
          : ["Card 0:triage", "Card 1:archived"],
      );

    // The regression, named: a leaked overlay style blocked every click.
    await expect
      .poll(() =>
        page.evaluate(() => getComputedStyle(document.body).pointerEvents),
      )
      .toBe("auto");

    // The symptom a person hits: the very next click has to land.
    await page.locator('button:has-text("Card 0")').click();
    await expect(detail(page)).toContainText("Card 0");
  });
}
