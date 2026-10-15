/**
 * Dragging a card over a lane says, before the drop, whether the lane's
 * automations will pick it up: an unowned card over In Progress names the
 * built-in Implementer, and a card a person owns, or a lane with nothing on
 * it, says nothing. The lane under the drag also shows its header actions, as
 * on a plain hover.
 *
 * A real pointer drag (dnd-kit's PointerSensor ignores Playwright's
 * `dragTo`), held over the lane so the hint can be read, then cancelled.
 */

import type { Locator, Page } from "@playwright/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

interface TaskBoardItem {
  id: string;
}

/** Pick up `source` and hold it over `target` without dropping. */
async function holdOver(page: Page, source: Locator, target: Locator) {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("holdOver: element not visible");
  await page.mouse.move(from.x + from.width / 2, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + 30, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 15 });
}

test.describe("task board drop hint", () => {
  test("an unowned card over In Progress says the Implementer will pick it up", async ({
    authedPage,
  }) => {
    const { page, orgSlug, user } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);
    // Seeded right after the org is created, off the signup request.
    await expect
      .poll(async () =>
        (
          await call<{ automations: { system_key: string | null }[] }>(
            "AUTOMATION_LIST",
            {},
          )
        ).automations.some((a) => a.system_key === "implementer"),
      )
      .toBe(true);
    await call("TASK_BOARD_ITEM_CREATE", { title: "Nobody owns this" });
    const { item: owned } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Someone owns this" },
    );
    await call("TASK_BOARD_ITEM_UPDATE", {
      id: owned.id,
      assigneeId: user.userId,
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/${orgSlug}/tasks`);
    const unowned = page.locator('button:has-text("Nobody owns this")');
    // The first board load of a fresh org can outlast the default 5 s.
    await expect(unowned).toBeVisible({ timeout: 30_000 });
    const inProgress = page.locator('[data-lane="in_progress"]');
    const hint = inProgress.getByRole("status");

    await holdOver(page, unowned, inProgress);
    await expect(hint).toHaveText("Implementer will pick this card up");
    // The lane's actions show as on a plain hover, though the dragged card
    // holds the pointer.
    await expect(
      inProgress.getByRole("button", { name: "New task in In Progress" }),
    ).toHaveCSS("opacity", "1");
    // Nothing runs on QA.
    await page.mouse.move(
      ...(await centerOf(page.locator('[data-lane="qa"]'))),
      { steps: 10 },
    );
    await expect(
      page.locator('[data-lane="qa"]').getByRole("status"),
    ).toHaveCount(0);
    await expect(hint).toHaveCount(0);
    // The Reviewer lives on In Review, but a drop there starts nothing: it
    // waits for the card's pull request.
    await page.mouse.move(
      ...(await centerOf(page.locator('[data-lane="in_review"]'))),
      { steps: 10 },
    );
    await expect(
      page.locator('[data-lane="in_review"]').getByRole("status"),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.mouse.up();

    // A person's card is never taken over.
    await holdOver(
      page,
      page.locator('button:has-text("Someone owns this")'),
      inProgress,
    );
    await expect(hint).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.mouse.up();
  });
});

async function centerOf(target: Locator): Promise<[number, number]> {
  const box = await target.boundingBox();
  if (!box) throw new Error("centerOf: element not visible");
  return [box.x + box.width / 2, box.y + 60];
}
