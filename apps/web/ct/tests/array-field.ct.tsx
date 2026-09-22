import { expect, test } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import { SchemaFormHarness } from "../harness/schema-form-harness";
import { sectionWithProps, TEST_RESOLVE_TYPE } from "../harness/fixtures";
import {
  openRowActionsMenu,
  readBreadcrumb,
  readFormValue,
} from "../harness/ct-utils";

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

  await openRowActionsMenu(component, "a");
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

  await openRowActionsMenu(component, "a");
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

/**
 * The add control is the list's last row in the compact layout, so it has to be
 * as tall as the rows it follows — including the taller rows that carry a
 * thumbnail. In classic it is still a block below the list, whose height does
 * not match, so this test fails if the preference below stops taking effect.
 */
async function enableCompactLayout(page: Page) {
  await page.evaluate((key) => {
    localStorage.setItem(key, JSON.stringify({ compactPageLayout: true }));
  }, LOCALSTORAGE_KEYS.preferences());
}

const BANNERS_WITH_THUMBNAILS = {
  banners: {
    type: "array",
    title: "Banners",
    items: {
      type: "object",
      properties: {
        image: { type: "string", format: "image-uri" },
        alt: { type: "string" },
      },
    },
  },
};

test("compact: the add row matches a thumbnail row's height", async ({
  mount,
  page,
}) => {
  await enableCompactLayout(page);
  const component = await mount(
    <SchemaFormHarness
      meta={sectionWithProps(BANNERS_WITH_THUMBNAILS)}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{
        banners: [{ image: "https://example.com/a.png", alt: "One" }],
      }}
    />,
  );

  const itemRow = component.locator('[role="button"][title]').first();
  // Attached, not visible: the fixture's src never loads, so it has no width.
  await expect(itemRow.locator("img")).toHaveCount(1);

  const item = await itemRow.boundingBox();
  const add = await component
    .getByRole("button", { name: "Add item" })
    .boundingBox();

  expect(add?.height).toBe(item?.height);
});

test("compact: the add row matches a plain row's height", async ({
  mount,
  page,
}) => {
  await enableCompactLayout(page);
  const component = await mount(
    <SchemaFormHarness
      meta={sectionWithProps({
        tags: { type: "array", title: "Tags", items: { type: "string" } },
      })}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{ tags: ["one"] }}
    />,
  );

  const item = await component
    .locator('[role="button"][title]')
    .first()
    .boundingBox();
  const add = await component
    .getByRole("button", { name: "Add item" })
    .boundingBox();

  expect(add?.height).toBe(item?.height);
});
