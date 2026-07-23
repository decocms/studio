import { expect, test } from "@playwright/experimental-ct-react";
import { SchemaFormHarness } from "../harness/schema-form-harness";
import { sectionWithProps, TEST_RESOLVE_TYPE } from "../harness/fixtures";
import { readBreadcrumb, readFormValue } from "../harness/ct-utils";

test("empty array shows an Add item button and no count badge", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    tags: { type: "array", title: "Tags", items: { type: "string" } },
  });
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{}}
    />,
  );

  await expect(component.getByText("Tags")).toBeVisible();
  await expect(
    component.getByRole("button", { name: "Add item" }),
  ).toBeVisible();
  // No item rows yet, so no count badge: the form value has no tags key.
  await expect.poll(() => readFormValue(component)).toEqual({});
  await expect.poll(() => readBreadcrumb(component)).toEqual([]);
});

test("add a string item appends an empty string and drills into it", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    tags: { type: "array", title: "Tags", items: { type: "string" } },
  });
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{}}
    />,
  );

  await component.getByRole("button", { name: "Add item" }).click();

  // The new item is appended as an empty string.
  await expect.poll(() => readFormValue(component)).toEqual({ tags: [""] });
  // Adding drills the breadcrumb into the new item.
  await expect
    .poll(async () => (await readBreadcrumb(component)).length)
    .toBeGreaterThan(0);
});

test("editing the drilled-in string item round-trips its value", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    tags: { type: "array", title: "Tags", items: { type: "string" } },
  });
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{}}
    />,
  );

  await component.getByRole("button", { name: "Add item" }).click();
  await expect.poll(() => readFormValue(component)).toEqual({ tags: [""] });

  // After drilling in, the item editor shows a string input labelled "Item 1".
  const itemInput = component.getByLabel("Item 1");
  await expect(itemInput).toBeVisible();
  await itemInput.fill("hello");

  await expect
    .poll(() => readFormValue(component))
    .toEqual({ tags: ["hello"] });
});

test("populated array shows item rows and a count badge", async ({ mount }) => {
  const meta = sectionWithProps({
    tags: { type: "array", title: "Tags", items: { type: "string" } },
  });
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{ tags: ["a", "b", "c"] }}
    />,
  );

  // Empty breadcrumb keeps the list view (not drilled into an item).
  await expect.poll(() => readBreadcrumb(component)).toEqual([]);

  // Count badge reflects the number of items.
  await expect(component.getByText("3", { exact: true })).toBeVisible();

  // Each row label shows the string value.
  await expect(component.getByText("a", { exact: true })).toBeVisible();
  await expect(component.getByText("b", { exact: true })).toBeVisible();
  await expect(component.getByText("c", { exact: true })).toBeVisible();
});

test("delete removes the targeted item from the list", async ({
  mount,
  page,
}) => {
  const meta = sectionWithProps({
    tags: { type: "array", title: "Tags", items: { type: "string" } },
  });
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{ tags: ["a", "b"] }}
    />,
  );

  await expect
    .poll(() => readFormValue(component))
    .toEqual({ tags: ["a", "b"] });

  // The per-row actions trigger is in the DOM (opacity-0 until hover) and clickable.
  // `exact` disambiguates the button from the sortable row (whose accessible
  // name embeds the button label).
  await component
    .getByRole("button", { name: "Open actions for a", exact: true })
    .click();
  // The DropdownMenu content is portaled onto document.body — query via page.
  await page.getByRole("menuitem", { name: "Delete" }).click();

  await expect.poll(() => readFormValue(component)).toEqual({ tags: ["b"] });
});

test("duplicate inserts a copy right after the targeted item", async ({
  mount,
  page,
}) => {
  const meta = sectionWithProps({
    tags: { type: "array", title: "Tags", items: { type: "string" } },
  });
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{ tags: ["a", "b"] }}
    />,
  );

  await expect
    .poll(() => readFormValue(component))
    .toEqual({ tags: ["a", "b"] });

  await component
    .getByRole("button", { name: "Open actions for a", exact: true })
    .click();
  // The DropdownMenu content is portaled onto document.body — query via page.
  await page.getByRole("menuitem", { name: "Duplicate" }).click();

  await expect
    .poll(() => readFormValue(component))
    .toEqual({ tags: ["a", "a", "b"] });
});

test("add a number item appends the default 0", async ({ mount }) => {
  const meta = sectionWithProps({
    nums: { type: "array", title: "Nums", items: { type: "number" } },
  });
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{}}
    />,
  );

  await component.getByRole("button", { name: "Add item" }).click();

  await expect.poll(() => readFormValue(component)).toEqual({ nums: [0] });
});

test("add a boolean item appends the default false", async ({ mount }) => {
  const meta = sectionWithProps({
    flags: { type: "array", title: "Flags", items: { type: "boolean" } },
  });
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{}}
    />,
  );

  await component.getByRole("button", { name: "Add item" }).click();

  await expect.poll(() => readFormValue(component)).toEqual({ flags: [false] });
});
