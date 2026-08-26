/**
 * The task dialog's "More actions" menu (`/$org?main=board` → card → ⋯).
 *
 * Guards the regression the dialog redesign shipped when Delete/Archive/Clone
 * moved from footer buttons into a Radix menu *inside* the dialog: picking an
 * item that closes the dialog tore two overlapping modal layers down in the
 * same tick, and the `pointer-events: none` the outer one puts on <body> was
 * left behind with no layer to restore it. The board kept updating over SSE
 * but the whole app stopped taking clicks — invisible to a unit test, since
 * the leak lives in the overlay teardown, not in the component's output.
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
  await page.goto(`/${orgSlug}?main=board`);
  // Generous: the board's first paint waits on the shell's route chunks.
  await expect(page.locator('button:has-text("Card 0")')).toBeVisible({
    timeout: 30_000,
  });
}

// Every item in this menu closes the dialog the same way, so the two that
// change the board prove the whole menu.
for (const action of ["Delete", "Archive"] as const) {
  test(`${action} from the dialog menu leaves the app clickable`, async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    await seedCards(request, orgSlug, 2);
    await openBoard(page, orgSlug);

    await page.locator('button:has-text("Card 1")').click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: action }).click();

    // Deleted or archived, the card leaves the board either way.
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
    await expect(page.getByRole("dialog")).toContainText("Card 0");
  });
}
