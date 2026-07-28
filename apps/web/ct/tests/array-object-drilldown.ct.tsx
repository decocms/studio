import { expect, test } from "@playwright/experimental-ct-react";
import type { Locator } from "@playwright/test";
import { SchemaFormHarness } from "../harness/schema-form-harness";
import { sectionWithProps, TEST_RESOLVE_TYPE } from "../harness/fixtures";
import { readBreadcrumb, readFormValue } from "../harness/ct-utils";

/**
 * The sortable row wrapper is a role=button whose accessible NAME concatenates
 * the label with its inline action buttons ("Alpha Hide item Open actions for
 * Alpha"), so an exact-name query no longer matches. Match rows by the visible
 * label text instead (the inline action buttons are icon-only, and the array
 * header label lives outside any button).
 */
const itemRow = (component: Locator, label: string) =>
  component.getByRole("button").filter({ hasText: label });

/**
 * ArrayField with OBJECT items + breadcrumb drill-down, exercised through the
 * full SchemaFormHarness (raw JSON Schema -> resolveSchema -> SchemaForm).
 *
 * The card item schema carries titleBy="name", so item rows are labelled by
 * their `name` value; drilling into a row swaps the list for that item's
 * nested object form (Name + Count) and pushes the row label onto the
 * breadcrumb trail.
 */
const cardArrayProps = {
  cards: {
    type: "array",
    title: "Cards",
    items: {
      type: "object",
      title: "Card",
      titleBy: "name",
      properties: {
        name: { type: "string", title: "Name" },
        count: { type: "number", title: "Count" },
      },
    },
  },
};

test("add object item: appends empty {} and drills into the nested fields", async ({
  mount,
}) => {
  const meta = sectionWithProps(cardArrayProps);
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await component.getByRole("button", { name: "Add item" }).click();

  // Empty object default pushed onto the array.
  await expect.poll(() => readFormValue(component)).toEqual({ cards: [{}] });

  // Breadcrumb drilled into the new row (label falls back to the item title).
  await expect.poll(() => readBreadcrumb(component)).toEqual(["Card"]);

  // Nested fields are now visible inline at paths cards.0.name / cards.0.count.
  const nameInput = component.getByLabel("Name");
  const countInput = component.getByLabel("Count");
  await expect(nameInput).toBeVisible();
  await expect(countInput).toBeVisible();
  await expect(nameInput).toHaveAttribute("id", "cards.0.name");
  await expect(countInput).toHaveAttribute("id", "cards.0.count");
});

test("add object item then edit Name updates cards[0].name", async ({
  mount,
}) => {
  const meta = sectionWithProps(cardArrayProps);
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await component.getByRole("button", { name: "Add item" }).click();
  await expect.poll(() => readFormValue(component)).toEqual({ cards: [{}] });

  await component.getByLabel("Name").fill("Hero");

  await expect
    .poll(() => readFormValue(component))
    .toEqual({ cards: [{ name: "Hero" }] });
});

test("editing a drilled-in object item sets both fields", async ({ mount }) => {
  const meta = sectionWithProps(cardArrayProps);
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await component.getByRole("button", { name: "Add item" }).click();
  await component.getByLabel("Name").fill("Hero");
  await component.getByLabel("Count").fill("3");

  await expect
    .poll(() => readFormValue(component))
    .toEqual({ cards: [{ name: "Hero", count: 3 }] });
});

test("item rows are labelled by titleBy with a count badge", async ({
  mount,
}) => {
  const meta = sectionWithProps(cardArrayProps);
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{ cards: [{ name: "Alpha" }, { name: "Beta" }] }}
    />,
  );

  // Empty breadcrumb -> list view with both rows.
  await expect.poll(() => readBreadcrumb(component)).toEqual([]);
  await expect(itemRow(component, "Alpha")).toBeVisible();
  await expect(itemRow(component, "Beta")).toBeVisible();

  // Count badge reflects the number of items.
  await expect(component.getByText("2", { exact: true })).toBeVisible();
});

test("clicking a row drills into that item and shows its Name value", async ({
  mount,
}) => {
  const meta = sectionWithProps(cardArrayProps);
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{ cards: [{ name: "Alpha" }, { name: "Beta" }] }}
    />,
  );

  await itemRow(component, "Alpha").click();

  // Breadcrumb drilled into the Alpha row.
  await expect.poll(() => readBreadcrumb(component)).toContain("Alpha");

  // The drilled-in Name field renders with the row's value.
  const nameInput = component.getByLabel("Name");
  await expect(nameInput).toBeVisible();
  await expect(nameInput).toHaveAttribute("id", "cards.0.name");
  await expect(nameInput).toHaveValue("Alpha");
});

test("editing a drilled-in item updates the correct index", async ({
  mount,
}) => {
  const meta = sectionWithProps(cardArrayProps);
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{ cards: [{ name: "Alpha" }, { name: "Beta" }] }}
    />,
  );

  // Drill into the second row (index 1).
  await itemRow(component, "Beta").click();
  await expect.poll(() => readBreadcrumb(component)).toContain("Beta");

  const nameInput = component.getByLabel("Name");
  await expect(nameInput).toHaveAttribute("id", "cards.1.name");
  await nameInput.fill("Beta2");

  await expect
    .poll(() => readFormValue(component))
    .toEqual({ cards: [{ name: "Alpha" }, { name: "Beta2" }] });
});

test("editing a label field whose value equals the array label keeps the editor open", async ({
  mount,
}) => {
  // Regression: an array labelled "Banner" whose single item is ALSO labelled
  // "Banner" (its label comes from `alt` via titleBy). The breadcrumb is
  // ["Banner", "Banner"]; editing `alt` must not collapse the trail and kick
  // you back to the list. Guards the SchemaForm consumed-prefix re-prepend.
  const meta = sectionWithProps({
    banner: {
      type: "array",
      title: "Banner",
      items: {
        type: "object",
        title: "Banner",
        titleBy: "alt",
        properties: { alt: { type: "string", title: "Alt" } },
      },
    },
  });
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{ banner: [{ alt: "Banner" }] }}
    />,
  );

  await itemRow(component, "Banner").click();
  await expect
    .poll(() => readBreadcrumb(component))
    .toEqual(["Banner", "Banner"]);

  const altInput = component.getByLabel("Alt");
  await expect(altInput).toHaveAttribute("id", "banner.0.alt");
  await altInput.fill("Banner Sale");

  // Editor stays open on the same item (does NOT drop back to the list), and
  // the edit is applied.
  await expect(component.getByLabel("Alt")).toHaveAttribute(
    "id",
    "banner.0.alt",
  );
  await expect(component.getByRole("button", { name: "Add item" })).toHaveCount(
    0,
  );
  await expect
    .poll(() => readFormValue(component))
    .toEqual({ banner: [{ alt: "Banner Sale" }] });
});

test("editing a label to collide with an earlier sibling keeps the opened row", async ({
  mount,
}) => {
  // Regression: drill into item 1, rename it to equal item 0's label. Selection
  // must stay on index 1 (not snap to the first matching label at index 0).
  // Guards the ArrayField openIndex/preferredIndex disambiguation.
  const meta = sectionWithProps(cardArrayProps);
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{ cards: [{ name: "Alpha" }, { name: "Beta" }] }}
    />,
  );

  await itemRow(component, "Beta").click();
  const nameInput = component.getByLabel("Name");
  await expect(nameInput).toHaveAttribute("id", "cards.1.name");

  await nameInput.fill("Alpha");

  // Still editing index 1 — not snapped to the identically-labelled index 0.
  await expect(component.getByLabel("Name")).toHaveAttribute(
    "id",
    "cards.1.name",
  );
  await expect
    .poll(() => readFormValue(component))
    .toEqual({ cards: [{ name: "Alpha" }, { name: "Alpha" }] });
});

test("deleting a row removes the right item from the array", async ({
  mount,
  page,
}) => {
  const meta = sectionWithProps(cardArrayProps);
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{ cards: [{ name: "Alpha" }, { name: "Beta" }] }}
    />,
  );

  // Open the actions menu for the Alpha row (button is in the DOM though
  // hidden). exact: true — the row wrapper is also a role=button whose
  // accessible name CONTAINS "Open actions for Alpha".
  await component
    .getByRole("button", { name: "Open actions for Alpha", exact: true })
    .click();
  // DropdownMenu content is portaled onto document.body -> query via page.
  await page.getByRole("menuitem", { name: "Delete" }).click();

  await expect
    .poll(() => readFormValue(component))
    .toEqual({ cards: [{ name: "Beta" }] });
});

test("fallback label 'Item 1' when itemSchema has no titleBy/title and item has no name", async ({
  mount,
}) => {
  // No titleBy and no title on the item schema, and the item carries no
  // name/label/title key -> getArrayItemLabel falls back to "Item <n>".
  const meta = sectionWithProps({
    cards: {
      type: "array",
      title: "Cards",
      items: {
        type: "object",
        properties: {
          count: { type: "number", title: "Count" },
        },
      },
    },
  });
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{ cards: [{ count: 7 }] }}
    />,
  );

  await expect.poll(() => readBreadcrumb(component)).toEqual([]);
  await expect(itemRow(component, "Item 1")).toBeVisible();
});
