import { expect, test } from "@playwright/experimental-ct-react";
import { PageVariantTabsHarness } from "../harness/variant-harnesses";
import { readEvents } from "../harness/ct-utils";
import type { PageVariant } from "@/components/sections-editor/page-variants";

/**
 * PageVariantTabs — the vertical page-variant list. Add a variant, select a
 * row, or open a row's actions menu to rename / duplicate / delete. Delete is
 * disabled when only one variant remains. The DropdownMenu is portaled →
 * queried via `page`.
 *
 * Rows are `<div role="button">` (dnd-kit spreads `{...attributes}`) whose
 * accessible name is computed from content, so it includes the nested
 * "Actions for X" trigger label. Select rows via `getByText(label)` and query
 * the actions trigger with `exact: true` to avoid matching the row.
 */
const TWO: PageVariant[] = [
  { label: "Default", sections: [] },
  { label: "Mobile", sections: [], rule: { __resolveType: "x/matchers/A.ts" } },
];

test("renders a row per variant plus an add button", async ({ mount }) => {
  const component = await mount(
    <PageVariantTabsHarness variants={TWO} activeIndex={0} />,
  );
  await expect(component.getByText("Default", { exact: true })).toBeVisible();
  await expect(component.getByText("Mobile", { exact: true })).toBeVisible();
  await expect(
    component.getByRole("button", { name: "Add variant" }),
  ).toBeVisible();
});

test("clicking the add button fires onAdd", async ({ mount }) => {
  const component = await mount(
    <PageVariantTabsHarness variants={TWO} activeIndex={0} />,
  );
  await component.getByRole("button", { name: "Add variant" }).click();
  await expect.poll(() => readEvents(component)).toEqual([{ type: "add" }]);
});

test("clicking a row fires onSelect with its index", async ({ mount }) => {
  const component = await mount(
    <PageVariantTabsHarness variants={TWO} activeIndex={0} />,
  );
  await component.getByText("Mobile", { exact: true }).click();
  await expect
    .poll(() => readEvents(component))
    .toEqual([{ type: "select", index: 1 }]);
});

test("rename from the tab menu fires onRename", async ({ mount, page }) => {
  const component = await mount(
    <PageVariantTabsHarness variants={TWO} activeIndex={0} />,
  );
  await component
    .getByRole("button", { name: "Actions for Mobile", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await expect
    .poll(() => readEvents(component))
    .toEqual([{ type: "rename", index: 1 }]);
});

test("duplicate from the tab menu fires onDuplicate", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <PageVariantTabsHarness variants={TWO} activeIndex={0} />,
  );
  await component
    .getByRole("button", { name: "Actions for Mobile", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect
    .poll(() => readEvents(component))
    .toEqual([{ type: "duplicate", index: 1 }]);
});

test("delete from the tab menu fires onDelete (multiple variants)", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <PageVariantTabsHarness variants={TWO} activeIndex={0} />,
  );
  await component
    .getByRole("button", { name: "Actions for Default", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect
    .poll(() => readEvents(component))
    .toEqual([{ type: "delete", index: 0 }]);
});

test("delete is disabled when only one variant remains", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <PageVariantTabsHarness
      variants={[{ label: "Solo", sections: [] }]}
      activeIndex={0}
    />,
  );
  await component
    .getByRole("button", { name: "Actions for Solo", exact: true })
    .click();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
});
