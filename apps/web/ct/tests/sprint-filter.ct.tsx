import { expect, test } from "@playwright/experimental-ct-react";
import { SprintFilterHarness } from "../harness/sprint-filter-harness";

/** `Mar 2 – Mar 15`, whatever month the suite runs in. */
const DATE_RANGE = /^\w{3} \d{1,2} – \w{3} \d{1,2}$/;

test("each option leads with its dates and trails a muted sprint name", async ({
  mount,
  page,
}) => {
  await mount(<SprintFilterHarness />);
  await page.getByRole("button", { name: "Sprint" }).click();

  const current = page.getByRole("menuitemradio", {
    name: /Sprint 1 \(current\)/,
  });
  await expect(current).toBeVisible();

  // The radio's own indicator span is absolutely positioned; skip it.
  const cells = current.locator("span:not([class*='absolute'])");
  await expect(cells.first()).toHaveText(DATE_RANGE);
  await expect(cells.last()).toHaveText("Sprint 1 (current)");
  await expect(cells.last()).toHaveClass(/text-muted-foreground/);
});

test("the horizon reaches well past the current sprint", async ({
  mount,
  page,
}) => {
  await mount(<SprintFilterHarness />);
  await page.getByRole("button", { name: "Sprint" }).click();

  await expect(
    page.getByRole("menuitemradio", { name: /Sprint 13$/ }),
  ).toBeVisible();
  // Any sprint + No sprint + the 13 offered sprints.
  await expect(page.getByRole("menuitemradio")).toHaveCount(15);
});

test("picking a sprint reports it to the board", async ({ mount, page }) => {
  const component = await mount(<SprintFilterHarness />);
  await page.getByRole("button", { name: "Sprint" }).click();
  await page.getByRole("menuitemradio", { name: /Sprint 7$/ }).click();

  await expect(component.getByTestId("sprint")).toHaveText("7");
});
