import { expect, test } from "@playwright/experimental-ct-react";
import { SchemaFormHarness } from "../harness/schema-form-harness";
import { sectionWithProps, TEST_RESOLVE_TYPE } from "../harness/fixtures";
import { readBreadcrumb, readFormValue } from "../harness/ct-utils";

const colorsMeta = sectionWithProps({
  colors: {
    type: "array",
    title: "Colors",
    items: {
      type: "object",
      titleBy: "name",
      properties: {
        name: { type: "string", title: "Name" },
        hex: { type: "string", title: "Hex" },
      },
    },
  },
});

const initialColors = {
  colors: [
    { name: "white", hex: "#ffffff" },
    { name: "black", hex: "#000000" },
    { name: "green", hex: "#2e7d32" },
  ],
};

test("lists open one item at a time by default", async ({ mount }) => {
  const component = await mount(
    <SchemaFormHarness
      meta={colorsMeta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={initialColors}
    />,
  );

  await component.getByTitle("black", { exact: true }).click();

  await expect.poll(() => readBreadcrumb(component)).toEqual(["black"]);
  await expect(component.getByTitle("white", { exact: true })).toHaveCount(0);
});

test("the inline layout edits items without leaving the list", async ({
  mount,
}) => {
  const component = await mount(
    <SchemaFormHarness
      meta={colorsMeta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={initialColors}
    />,
  );

  await component
    .getByRole("radio", { name: "Edit items in the list" })
    .click();
  await component.getByTitle("black", { exact: true }).click();
  await component.getByTitle("green", { exact: true }).click();

  await expect(component.getByTitle("black", { exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(component.getByTitle("white", { exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(component.getByLabel("Hex")).toHaveCount(2);

  await component.getByLabel("Hex").last().fill("#1b5e20");

  await expect
    .poll(() => readFormValue(component))
    .toEqual({
      colors: [
        { name: "white", hex: "#ffffff" },
        { name: "black", hex: "#000000" },
        { name: "green", hex: "#1b5e20" },
      ],
    });
  await expect.poll(() => readBreadcrumb(component)).toEqual([]);
  await expect(component.getByTitle("white", { exact: true })).toBeVisible();
});

test("clicking an expanded row collapses it", async ({ mount }) => {
  const component = await mount(
    <SchemaFormHarness
      meta={colorsMeta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={initialColors}
    />,
  );

  await component
    .getByRole("radio", { name: "Edit items in the list" })
    .click();
  const row = component.getByTitle("white", { exact: true });
  await row.click();
  await expect(component.getByLabel("Hex")).toHaveCount(1);
  await row.click();

  await expect(component.getByLabel("Hex")).toHaveCount(0);
  await expect(row).toHaveAttribute("aria-expanded", "false");
});

test("adding an item in the inline layout expands it in place", async ({
  mount,
}) => {
  const component = await mount(
    <SchemaFormHarness
      meta={colorsMeta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={initialColors}
    />,
  );

  await component
    .getByRole("radio", { name: "Edit items in the list" })
    .click();
  await component.getByRole("button", { name: "Add item" }).click();

  await expect(component.getByLabel("Name")).toHaveCount(1);
  await component.getByLabel("Name").fill("navy");

  await expect
    .poll(() => readFormValue(component))
    .toEqual({
      colors: [...initialColors.colors, { name: "navy" }],
    });
  await expect.poll(() => readBreadcrumb(component)).toEqual([]);
});

test("the layout choice persists across mounts", async ({ mount, page }) => {
  const first = await mount(
    <SchemaFormHarness
      meta={colorsMeta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={initialColors}
    />,
  );
  await first.getByRole("radio", { name: "Edit items in the list" }).click();
  await first.unmount();

  await page.reload();
  const second = await mount(
    <SchemaFormHarness
      meta={colorsMeta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={initialColors}
    />,
  );
  await second.getByTitle("white", { exact: true }).click();

  await expect(second.getByLabel("Hex")).toHaveCount(1);
  await expect.poll(() => readBreadcrumb(second)).toEqual([]);
});

test("section lists keep opening one section at a time", async ({ mount }) => {
  const meta = sectionWithProps({
    sections: {
      type: "array",
      title: "Sections",
      items: { type: "object", properties: { title: { type: "string" } } },
    },
  });
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{ sections: [{ title: "Hero" }] }}
    />,
  );

  await expect(
    component.getByRole("radio", { name: "Edit items in the list" }),
  ).toHaveCount(0);
});
