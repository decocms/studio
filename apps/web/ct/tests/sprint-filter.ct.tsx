import { expect, test } from "@playwright/experimental-ct-react";
import { SprintFilterHarness } from "../harness/sprint-filter-harness";

/** `Mar 2 – Mar 15` — the month names follow the browser locale. */
const DATE_RANGE = /^\w{3} \d{1,2} – \w{3} \d{1,2}$/;

test("each option leads with the sprint's name and trails its dates", async ({
  mount,
  page,
}) => {
  await mount(<SprintFilterHarness />);
  await page.getByRole("button", { name: "Sprint" }).click();

  const next = page.getByRole("menuitemradio", { name: /^Sprint 13/ });
  // The radio's own indicator span is absolutely positioned; skip it.
  const cells = next.locator("span:not([class*='absolute'])");
  await expect(cells.first()).toHaveText("Sprint 13");
  await expect(cells.last()).toHaveText(DATE_RANGE);
  await expect(cells.last()).toHaveClass(/text-muted-foreground/);
});

test("the running sprint reads as current instead of showing dates", async ({
  mount,
  page,
}) => {
  await mount(<SprintFilterHarness />);
  await page.getByRole("button", { name: "Sprint" }).click();

  const active = page.getByRole("menuitemradio", { name: /^Sprint 12/ });
  const cells = active.locator("span:not([class*='absolute'])");
  await expect(cells.last()).toHaveText("current");
});

test("offers every mirrored sprint, running first and history last", async ({
  mount,
  page,
}) => {
  await mount(<SprintFilterHarness />);
  await page.getByRole("button", { name: "Sprint" }).click();

  // Any sprint + No sprint + the four mirrored sprints.
  const options = page.getByRole("menuitemradio");
  await expect(options).toHaveCount(6);
  await expect(options.nth(2)).toContainText("Sprint 12");
  await expect(options.nth(5)).toContainText("Sprint 11");
});

test("a sprint with no dates still offers itself, with an empty trailing cell", async ({
  mount,
  page,
}) => {
  await mount(<SprintFilterHarness />);
  await page.getByRole("button", { name: "Sprint" }).click();

  const undated = page.getByRole("menuitemradio", { name: /^Sprint 14/ });
  await expect(undated).toBeVisible();
  await expect(
    undated.locator("span:not([class*='absolute'])").last(),
  ).toHaveText("");
});

test("picking a sprint reports its id to the board", async ({
  mount,
  page,
}) => {
  const component = await mount(<SprintFilterHarness />);
  await page.getByRole("button", { name: "Sprint" }).click();
  await page.getByRole("menuitemradio", { name: /^Sprint 13/ }).click();

  await expect(component.getByTestId("sprint")).toHaveText('"sprint_next"');
});
