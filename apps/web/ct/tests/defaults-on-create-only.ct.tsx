import { expect, test } from "@playwright/experimental-ct-react";
import { SchemaFormHarness } from "../harness/schema-form-harness";
import { sectionWithProps, TEST_RESOLVE_TYPE } from "../harness/fixtures";
import { openRowActionsMenu, readFormValue } from "../harness/ct-utils";

const meta = sectionWithProps({
  title: { type: "string", title: "Title", default: "Hello" },
  subtitle: { type: "string", title: "Subtitle" },
  links: {
    type: "array",
    title: "Links",
    items: {
      type: "object",
      properties: {
        label: { type: "string", title: "Label" },
        display: { type: "boolean", title: "Display", default: true },
      },
    },
  },
});

test("by default, opening a section form writes its missing defaults", async ({
  mount,
}) => {
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await expect
    .poll(() => readFormValue(component))
    .toMatchObject({ title: "Hello" });
});

test("defaults only on creation: the form edits the stored block, so editing one field writes only that field", async ({
  mount,
}) => {
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      defaultsOnCreateOnly
      initialValue={{ subtitle: "Old", links: [{ label: "A" }] }}
    />,
  );

  // Shown as stored: the runtime gets no `title` either.
  await expect(component.getByLabel("Title", { exact: true })).toHaveValue("");
  await expect(component.getByTestId("write-count")).toHaveText("0");

  await component.getByLabel("Subtitle").fill("World");
  await expect
    .poll(() => readFormValue(component))
    .toEqual({ subtitle: "World", links: [{ label: "A" }] });
});

test("defaults only on creation: a new array item starts with its defaults", async ({
  mount,
}) => {
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      defaultsOnCreateOnly
      initialValue={{ links: [{ label: "A" }] }}
    />,
  );

  await component.getByRole("button", { name: "Add item" }).click();

  await expect
    .poll(() => readFormValue(component))
    .toEqual({ links: [{ label: "A" }, { display: true }] });
});

test("defaults only on creation: duplicating an item copies it as stored", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      defaultsOnCreateOnly
      initialValue={{ links: [{ label: "A" }] }}
    />,
  );

  await openRowActionsMenu(component, "A");
  // The DropdownMenu content is portaled onto document.body — query via page.
  await page.getByRole("menuitem", { name: "Duplicate" }).click();

  await expect
    .poll(() => readFormValue(component))
    .toEqual({ links: [{ label: "A" }, { label: "A" }] });
});

for (const [stored, initialValue] of [
  ["an absent", {}],
  ["a null", { card: null }],
] as const) {
  test(`defaults only on creation: the first edit inside ${stored} object creates it with its defaults`, async ({
    mount,
  }) => {
    const withCard = sectionWithProps({
      card: {
        type: "object",
        title: "Card",
        properties: {
          heading: { type: "string", title: "Heading" },
          showPrice: { type: "boolean", title: "Show price", default: true },
        },
      },
    });
    const component = await mount(
      <SchemaFormHarness
        meta={withCard}
        resolveType={TEST_RESOLVE_TYPE}
        defaultsOnCreateOnly
        initialValue={initialValue}
      />,
    );

    await component.getByRole("button", { name: "Card" }).click();
    await component.getByLabel("Heading").fill("Hi");

    await expect
      .poll(() => readFormValue(component))
      .toEqual({ card: { heading: "Hi", showPrice: true } });
  });
}

test("a form that never fills defaults (the blog's) adds an array item without them", async ({
  mount,
}) => {
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      withoutDefaultSeeding
      initialValue={{ links: [] }}
    />,
  );

  await component.getByRole("button", { name: "Add item" }).click();

  await expect.poll(() => readFormValue(component)).toEqual({ links: [{}] });
});
