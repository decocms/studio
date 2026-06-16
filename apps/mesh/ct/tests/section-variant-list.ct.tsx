import { expect, test } from "@playwright/experimental-ct-react";
import { SectionVariantListHarness } from "../harness/variant-harnesses";
import { readEvents } from "../harness/ct-utils";

/**
 * SectionVariantList — the A/B section variants sidebar. Callback-driven:
 * select a row, or open a row's actions menu to duplicate / delete; plus a
 * "remove all" affordance. Delete is disabled when only one variant remains.
 * DropdownMenu content is portaled → queried via `page`.
 */
const TWO = [
  { index: 0, label: "Default" },
  { index: 1, label: "Variant B" },
];

test("renders a row per variant", async ({ mount }) => {
  const component = await mount(
    <SectionVariantListHarness variants={TWO} selectedIndex={0} />,
  );
  await expect(component.getByText("Default", { exact: true })).toBeVisible();
  await expect(component.getByText("Variant B", { exact: true })).toBeVisible();
});

test("clicking a row fires onSelect with its index", async ({ mount }) => {
  const component = await mount(
    <SectionVariantListHarness variants={TWO} selectedIndex={0} />,
  );
  await component.getByText("Variant B", { exact: true }).click();
  await expect
    .poll(() => readEvents(component))
    .toEqual([{ type: "select", index: 1 }]);
});

test("duplicate from the row menu fires onDuplicate", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <SectionVariantListHarness variants={TWO} selectedIndex={0} />,
  );
  await component
    .getByRole("button", { name: "Open actions for Variant B", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect
    .poll(() => readEvents(component))
    .toEqual([{ type: "duplicate", index: 1 }]);
});

test("delete from the row menu fires onDelete (multiple variants)", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <SectionVariantListHarness variants={TWO} selectedIndex={0} />,
  );
  await component
    .getByRole("button", { name: "Open actions for Default", exact: true })
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
    <SectionVariantListHarness
      variants={[{ index: 0, label: "Only" }]}
      selectedIndex={0}
    />,
  );
  await component
    .getByRole("button", { name: "Open actions for Only", exact: true })
    .click();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
});

test("remove-all fires onRemoveAll", async ({ mount }) => {
  const component = await mount(
    <SectionVariantListHarness variants={TWO} selectedIndex={0} />,
  );
  await component.getByRole("button", { name: "Remove all variants" }).click();
  await expect
    .poll(() => readEvents(component))
    .toEqual([{ type: "removeAll" }]);
});

test("add-variant button fires onAdd", async ({ mount }) => {
  const component = await mount(
    <SectionVariantListHarness variants={TWO} selectedIndex={0} />,
  );
  await component.getByRole("button", { name: "Add variant" }).click();
  await expect.poll(() => readEvents(component)).toEqual([{ type: "add" }]);
});
