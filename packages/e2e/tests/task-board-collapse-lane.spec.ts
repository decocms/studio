/**
 * Collapsing a lane on the Tasks board (`/$org/tasks`): the lane shrinks to a
 * strip, the choice survives a reload, and the strip still takes a drop.
 */

import type { Locator, Page } from "@playwright/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

interface ListedItem {
  title: string;
  status: string;
}

/** dnd-kit's PointerSensor needs real pointer moves past its 4px activation
 *  distance; Playwright's dragTo() never engages it. */
async function pointerDrag(page: Page, source: Locator, target: Locator) {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("pointerDrag: element not visible");
  await page.mouse.move(from.x + from.width / 2, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + 30, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + 40, { steps: 15 });
  await page.mouse.up();
}

test("a collapsed lane stays collapsed across a reload and still takes a drop", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  const request = page.context().request;
  await callSelfMcpTool(request, orgSlug, "TASK_BOARD_ITEM_CREATE", {
    title: "Card to drop",
  });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`/${orgSlug}/tasks`);
  await expect(page.locator('button:has-text("Card to drop")')).toBeVisible({
    timeout: 15_000,
  });

  const lane = page.locator('[data-lane="in_progress"]');
  await lane.hover();
  await lane.getByRole("button", { name: /^Collapse / }).click();
  await expect(lane).toHaveAttribute("data-lane-collapsed", "");
  expect((await lane.boundingBox())?.width).toBeLessThan(60);

  await page.reload();
  await expect(page.locator('[data-lane="in_progress"]')).toHaveAttribute(
    "data-lane-collapsed",
    "",
  );

  await pointerDrag(
    page,
    page.locator('button:has-text("Card to drop")'),
    page.locator('[data-lane="in_progress"]'),
  );
  await expect
    .poll(async () => {
      const { items } = await callSelfMcpTool<{ items: ListedItem[] }>(
        request,
        orgSlug,
        "TASK_BOARD_ITEM_LIST",
        {},
      );
      return items.find((i) => i.title === "Card to drop")?.status;
    })
    .toBe("in_progress");

  const collapsed = page.locator('[data-lane="in_progress"]');
  await collapsed.hover();
  await collapsed.getByRole("button", { name: /^Expand / }).click();
  await expect(page.locator('[data-lane="in_progress"]')).not.toHaveAttribute(
    "data-lane-collapsed",
  );
  await expect(
    page.locator('[data-lane="in_progress"] button:has-text("Card to drop")'),
  ).toBeVisible();
});
