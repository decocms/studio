import { expect, test } from "@playwright/experimental-ct-react";
import { PageVariantTabsHarness } from "../harness/variant-harnesses";
import { readEvents } from "../harness/ct-utils";
import type { PageVariant } from "@/web/components/sections-editor/page-variants";

/**
 * PageVariantTabs — the horizontal page-variant tab strip. Add a variant,
 * select a tab, or open a tab's actions menu to rename / duplicate / delete.
 * Delete is disabled when only one variant remains. The DropdownMenu is
 * portaled → queried via `page`.
 */
const TWO: PageVariant[] = [
  { label: "Default", sections: [] },
  { label: "Mobile", sections: [], rule: { __resolveType: "x/matchers/A.ts" } },
];

test("renders a tab per variant plus an add button", async ({ mount }) => {
  const component = await mount(
    <PageVariantTabsHarness variants={TWO} activeIndex={0} />,
  );
  await expect(
    component.getByRole("button", { name: "Default", exact: true }),
  ).toBeVisible();
  await expect(
    component.getByRole("button", { name: "Mobile", exact: true }),
  ).toBeVisible();
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

test("clicking a tab fires onSelect with its index", async ({ mount }) => {
  const component = await mount(
    <PageVariantTabsHarness variants={TWO} activeIndex={0} />,
  );
  await component.getByRole("button", { name: "Mobile", exact: true }).click();
  await expect
    .poll(() => readEvents(component))
    .toEqual([{ type: "select", index: 1 }]);
});

test("rename from the tab menu fires onRename", async ({ mount, page }) => {
  const component = await mount(
    <PageVariantTabsHarness variants={TWO} activeIndex={0} />,
  );
  await component.getByRole("button", { name: "Actions for Mobile" }).click();
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
  await component.getByRole("button", { name: "Actions for Mobile" }).click();
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
  await component.getByRole("button", { name: "Actions for Default" }).click();
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
  await component.getByRole("button", { name: "Actions for Solo" }).click();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
});
