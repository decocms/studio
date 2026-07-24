import { expect, test } from "@playwright/experimental-ct-react";
import { MatcherPickerHarness } from "../harness/variant-harnesses";
import { readEvents } from "../harness/ct-utils";
import type { MatcherEntry } from "@/components/sections-editor/matcher-picker";

/**
 * MatcherPicker — a trigger button + cmdk CommandDialog (portaled → queried via
 * `page`). The list always offers "Always" (selecting it emits "") plus one
 * entry per matcher (emitting its resolveType). Selecting closes the dialog.
 */
const MATCHERS: MatcherEntry[] = [
  {
    resolveType: "site/matchers/Device.ts",
    title: "Device",
    description: "Match by device type",
    iconName: "Phone01",
  },
  {
    resolveType: "site/matchers/Geo.ts",
    title: "Geolocation",
    description: "Match by country",
    iconName: "Globe01",
  },
];

test("the trigger shows the current label", async ({ mount }) => {
  const component = await mount(
    <MatcherPickerHarness
      currentRt=""
      currentLabel="Always"
      matchers={MATCHERS}
    />,
  );
  await expect(component.getByRole("button", { name: "Always" })).toBeVisible();
});

test("clicking the trigger opens the rule dialog", async ({ mount, page }) => {
  const component = await mount(
    <MatcherPickerHarness
      currentRt=""
      currentLabel="Always"
      matchers={MATCHERS}
    />,
  );
  await component.getByRole("button", { name: "Always" }).click();
  await expect(page.getByPlaceholder("Search rules...")).toBeVisible();
  await expect(page.getByRole("option", { name: /Device/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Geolocation/ })).toBeVisible();
});

test("selecting Always emits an empty resolveType", async ({ mount, page }) => {
  const component = await mount(
    <MatcherPickerHarness
      currentRt="site/matchers/Device.ts"
      currentLabel="Device"
      matchers={MATCHERS}
    />,
  );
  await component.getByRole("button", { name: "Device" }).click();
  await page.getByRole("option", { name: /Target all users/ }).click();
  await expect
    .poll(() => readEvents(component))
    .toEqual([{ type: "select", resolveType: "" }]);
});

test("selecting a matcher emits its resolveType", async ({ mount, page }) => {
  const component = await mount(
    <MatcherPickerHarness
      currentRt=""
      currentLabel="Always"
      matchers={MATCHERS}
    />,
  );
  await component.getByRole("button", { name: "Always" }).click();
  await page.getByRole("option", { name: /Geolocation/ }).click();
  await expect
    .poll(() => readEvents(component))
    .toEqual([{ type: "select", resolveType: "site/matchers/Geo.ts" }]);
});

test("selecting a rule closes the dialog", async ({ mount, page }) => {
  const component = await mount(
    <MatcherPickerHarness
      currentRt=""
      currentLabel="Always"
      matchers={MATCHERS}
    />,
  );
  await component.getByRole("button", { name: "Always" }).click();
  await page.getByRole("option", { name: /Device/ }).click();
  await expect(page.getByPlaceholder("Search rules...")).toHaveCount(0);
});

test("typing in the search filters the rule list", async ({ mount, page }) => {
  const component = await mount(
    <MatcherPickerHarness
      currentRt=""
      currentLabel="Always"
      matchers={MATCHERS}
    />,
  );
  await component.getByRole("button", { name: "Always" }).click();
  await page.getByPlaceholder("Search rules...").fill("Geoloc");
  await expect(page.getByRole("option", { name: /Geolocation/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Device/ })).toHaveCount(0);
});

const GLOBALS = [
  {
    blockKey: "TestHero",
    title: "Test Hero",
    description: "50% of sessions",
    iconName: "Shuffle01",
  },
  {
    blockKey: "MobileOnly",
    title: "Mobile Only",
    description: "Mobile",
    iconName: "Phone01",
  },
];

test("renders saved global rules in a separate group", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <MatcherPickerHarness
      currentRt=""
      currentLabel="Always"
      matchers={MATCHERS}
      globals={GLOBALS}
    />,
  );
  await component.getByRole("button", { name: "Always" }).click();
  await expect(page.getByRole("option", { name: /Test Hero/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Mobile Only/ })).toBeVisible();
});

test("selecting a global emits its blockKey", async ({ mount, page }) => {
  const component = await mount(
    <MatcherPickerHarness
      currentRt=""
      currentLabel="Always"
      matchers={MATCHERS}
      globals={GLOBALS}
    />,
  );
  await component.getByRole("button", { name: "Always" }).click();
  await page.getByRole("option", { name: /Test Hero/ }).click();
  await expect
    .poll(() => readEvents(component))
    .toEqual([{ type: "selectGlobal", blockKey: "TestHero" }]);
});

test("search matches globals by title and description", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <MatcherPickerHarness
      currentRt=""
      currentLabel="Always"
      matchers={MATCHERS}
      globals={GLOBALS}
    />,
  );
  await component.getByRole("button", { name: "Always" }).click();
  await page.getByPlaceholder("Search rules...").fill("Hero");
  await expect(page.getByRole("option", { name: /Test Hero/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Mobile Only/ })).toHaveCount(
    0,
  );
});
