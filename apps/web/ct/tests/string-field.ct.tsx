import { expect, test } from "@playwright/experimental-ct-react";
import { SchemaFormHarness } from "../harness/schema-form-harness";
import { sectionWithProps, TEST_RESOLVE_TYPE } from "../harness/fixtures";
import { hoverFieldDescription, readFormValue } from "../harness/ct-utils";

test("plain string renders a textbox and round-trips typed value", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    title: { type: "string", title: "Title" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const input = component.getByLabel("Title");
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("type", "text");
  await input.fill("Hello");

  await expect.poll(() => readFormValue(component)).toEqual({ title: "Hello" });
});

test("default value is used as the input placeholder", async ({ mount }) => {
  const meta = sectionWithProps({
    title: { type: "string", title: "Title", default: "placeholder text" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const input = component.getByLabel("Title");
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("placeholder", "placeholder text");
});

test("url format renders input[type=url] and round-trips typed value", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    link: { type: "string", title: "Link", format: "url" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const input = component.getByLabel("Link");
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("type", "url");
  await input.fill("https://deco.cx");

  await expect
    .poll(() => readFormValue(component))
    .toEqual({ link: "https://deco.cx" });
});

test("textarea format renders a <textarea> and round-trips typed value", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    body: { type: "string", title: "Body", format: "textarea" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const field = component.getByLabel("Body");
  await expect(field).toBeVisible();
  await expect(component.locator("textarea#body")).toBeVisible();
  await field.fill("multi\nline\ntext");

  await expect
    .poll(() => readFormValue(component))
    .toEqual({ body: "multi\nline\ntext" });
});

// rich-text / rich-text-inline now render a TipTap rich editor (toolbar +
// contenteditable ProseMirror) instead of a <textarea>; the model value is HTML.
test("rich-text format renders a rich editor and round-trips typed value as HTML", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    body: { type: "string", title: "Body", format: "rich-text" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await expect(component.getByText("Body")).toBeVisible();
  await expect(component.getByRole("button", { name: "Bold" })).toBeVisible();
  const editor = component.locator('[contenteditable="true"]');
  await expect(editor).toBeVisible();
  await editor.fill("rich content");

  await expect
    .poll(() => readFormValue(component))
    .toEqual({ body: "<p>rich content</p>" });
});

// rich-text-inline serializes WITHOUT a block wrapper: its value is injected
// where a <p>/<div> can't legally nest, so the outer paragraph is unwrapped.
test("rich-text-inline format renders a rich editor and round-trips typed value as inline HTML (no block wrapper)", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    body: { type: "string", title: "Body", format: "rich-text-inline" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await expect(component.getByText("Body")).toBeVisible();
  // Block-structure controls are hidden in inline mode.
  await expect(component.getByLabel("Text style")).toBeHidden();
  const editor = component.locator('[contenteditable="true"]');
  await expect(editor).toBeVisible();
  await editor.fill("inline content");

  await expect
    .poll(() => readFormValue(component))
    .toEqual({ body: "inline content" });
});

test("markdown format renders a <textarea> and round-trips typed value", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    body: { type: "string", title: "Body", format: "markdown" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const field = component.getByLabel("Body");
  await expect(field).toBeVisible();
  await expect(component.locator("textarea#body")).toBeVisible();
  await field.fill("# heading");

  await expect
    .poll(() => readFormValue(component))
    .toEqual({ body: "# heading" });
});

test("color-input format renders a color input plus a text input", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    color: { type: "string", title: "Color", format: "color-input" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await expect(component.locator('input[type="color"]')).toBeVisible();
  const textInput = component.getByLabel("Color");
  await expect(textInput).toBeVisible();
});

test("color-input text input round-trips the hex value", async ({ mount }) => {
  const meta = sectionWithProps({
    color: { type: "string", title: "Color", format: "color-input" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await component.getByLabel("Color").fill("#ff0000");

  await expect
    .poll(() => readFormValue(component))
    .toEqual({ color: "#ff0000" });
});

// deco sites (via @decocms/start's `Color` widget alias) emit format: "color".
test('"color" format renders a color input plus a text input', async ({
  mount,
}) => {
  const meta = sectionWithProps({
    color: { type: "string", title: "Color", format: "color" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await expect(component.locator('input[type="color"]')).toBeVisible();
  const textInput = component.getByLabel("Color");
  await expect(textInput).toBeVisible();
});

test("date format renders input[type=date] and converts to an ISO string", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    when: { type: "string", title: "When", format: "date" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const input = component.getByLabel("When");
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("type", "date");
  await input.fill("2024-01-15");

  await expect
    .poll(() => readFormValue(component))
    .toEqual({ when: "2024-01-15T00:00:00.000Z" });
});

test("date format exposes an Open calendar button", async ({ mount }) => {
  const meta = sectionWithProps({
    when: { type: "string", title: "When", format: "date" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await expect(
    component.getByRole("button", { name: "Open calendar" }),
  ).toBeVisible();
});

test("date-time format renders input[type=datetime-local] and converts to an ISO string", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    when: { type: "string", title: "When", format: "date-time" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const input = component.getByLabel("When");
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("type", "datetime-local");
  await input.fill("2024-06-15T10:30");

  // Resulting ISO string is timezone-dependent; assert shape, not exact value.
  await expect
    .poll(async () => {
      const value = (await readFormValue(component)) as { when?: unknown };
      return (
        typeof value.when === "string" &&
        /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value.when)
      );
    })
    .toBe(true);
});

test("description text is shown as a help tooltip alongside the field", async ({
  mount,
  page,
}) => {
  const meta = sectionWithProps({
    title: { type: "string", title: "Title", description: "Help text" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await expect(component.getByText("Help text")).not.toBeVisible();
  await expect(
    await hoverFieldDescription(component, page, "Help text"),
  ).toBeVisible();
});
