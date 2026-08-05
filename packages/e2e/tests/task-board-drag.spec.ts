/**
 * Kanban drag-and-drop on the Tasks overlay (`/$org?main=board`).
 *
 * These guard two regressions that the pre-dnd-kit implementation shipped:
 * a card dropped into another lane stayed permanently faded (its `dragend`
 * never fired because the move unmounted the node), and a multi-card drag
 * collapsed the selection into a single visible card. Both are invisible to
 * unit tests — they need a real pointer drag in a real browser.
 */

import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

interface ListedItem {
  title: string;
  status: string;
}

/** dnd-kit's PointerSensor requires real pointer events with intermediate
 *  moves past its 4px activation distance — Playwright's dragTo() dispatches
 *  HTML5 drag events instead and never engages the sensor. */
async function pointerDrag(page: Page, source: Locator, target: Locator) {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("pointerDrag: element not visible");
  await page.mouse.move(from.x + from.width / 2, from.y + 20);
  await page.mouse.down();
  // Cross the activation threshold, then travel to the target lane.
  await page.mouse.move(from.x + from.width / 2, from.y + 30, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 15 });
  await page.mouse.up();
}

async function seedCards(
  request: APIRequestContext,
  orgSlug: string,
  count: number,
) {
  for (let i = 0; i < count; i++) {
    await callSelfMcpTool(request, orgSlug, "TASK_BOARD_ITEM_CREATE", {
      title: `Card ${i}`,
      priority: "medium",
    });
  }
}

async function statusByTitle(request: APIRequestContext, orgSlug: string) {
  const { items } = await callSelfMcpTool<{ items: ListedItem[] }>(
    request,
    orgSlug,
    "TASK_BOARD_ITEM_LIST",
    {},
  );
  return Object.fromEntries(items.map((i) => [i.title, i.status]));
}

async function openBoard(page: Page, orgSlug: string) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/${orgSlug}?main=board`);
  await expect(page.locator('button:has-text("Card 0")')).toBeVisible();
}

test("a card dragged to another lane moves and stays fully visible", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  const request = page.context().request;
  await seedCards(request, orgSlug, 4);
  await openBoard(page, orgSlug);

  await pointerDrag(
    page,
    page.locator('button:has-text("Card 3")'),
    page.locator('[data-lane="todo"]'),
  );

  const moved = page.locator('[data-lane="todo"] button:has-text("Card 3")');
  await expect(moved).toBeVisible();
  // The regression: the dropped card was left at opacity 0.5 forever.
  await expect(moved).toHaveCSS("opacity", "1");

  await expect
    .poll(() => statusByTitle(request, orgSlug))
    .toMatchObject({ "Card 3": "todo", "Card 0": "triage" });
});

test("every card in a multi-selection moves together and none are hidden", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  const request = page.context().request;
  await seedCards(request, orgSlug, 4);
  await openBoard(page, orgSlug);

  // Shift-click builds the selection (see TaskCard's onClick).
  await page
    .locator('button:has-text("Card 3")')
    .click({ modifiers: ["Shift"] });
  await page
    .locator('button:has-text("Card 2")')
    .click({ modifiers: ["Shift"] });

  await pointerDrag(
    page,
    page.locator('button:has-text("Card 3")'),
    page.locator('[data-lane="in_progress"]'),
  );

  // The regression: the group collapsed into one faded card, because the
  // hide-siblings state never cleared after the drop.
  for (const title of ["Card 2", "Card 3"]) {
    const card = page.locator(
      `[data-lane="in_progress"] button:has-text("${title}")`,
    );
    await expect(card).toBeVisible();
    await expect(card).toHaveCSS("opacity", "1");
  }

  await expect
    .poll(() => statusByTitle(request, orgSlug))
    .toMatchObject({
      "Card 2": "in_progress",
      "Card 3": "in_progress",
      "Card 1": "triage",
    });
});
