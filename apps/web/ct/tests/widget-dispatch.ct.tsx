import { expect, test } from "@playwright/experimental-ct-react";
import { SchemaFormHarness } from "../harness/schema-form-harness";
import { sectionWithProps, TEST_RESOLVE_TYPE } from "../harness/fixtures";

/**
 * Widget dispatch matrix — the regression net guarding that "the right widget
 * renders for each schema shape". One section property per case, fed through
 * resolveSchema → SchemaForm → renderField, asserting only the DISTINGUISHING
 * element of the expected widget is visible.
 */

test("string schema → text input", async ({ mount }) => {
  const meta = sectionWithProps({
    title: { type: "string", title: "Title" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const input = component.getByLabel("Title");
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("type", "text");
});

test("number schema → number input", async ({ mount }) => {
  const meta = sectionWithProps({
    count: { type: "number", title: "Count" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const input = component.getByLabel("Count");
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("type", "number");
});

test("integer schema → number input", async ({ mount }) => {
  const meta = sectionWithProps({
    quantity: { type: "integer", title: "Quantity" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const input = component.getByLabel("Quantity");
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("type", "number");
});

test("boolean schema → switch", async ({ mount }) => {
  const meta = sectionWithProps({
    active: { type: "boolean", title: "Active" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const sw = component.getByLabel("Active");
  await expect(sw).toBeVisible();
  // BooleanField renders a Radix Switch (role="switch"); getByLabel resolves
  // to that button via <Label htmlFor={path}>.
  await expect(sw).toBeChecked({ checked: false });
  await expect(component.getByRole("switch", { name: "Active" })).toBeVisible();
});

test("enum schema → combobox select", async ({ mount }) => {
  const meta = sectionWithProps({
    variant: { type: "string", title: "Variant", enum: ["a", "b"] },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const combobox = component.getByRole("combobox");
  await expect(combobox).toBeVisible();
});

test("image-uri format → ImageField picker", async ({ mount }) => {
  const meta = sectionWithProps({
    hero: { type: "string", title: "Hero", format: "image-uri" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await expect(
    component.getByText("Drop an image or click to browse"),
  ).toBeVisible();
});

test("file-uri format → FileField picker", async ({ mount }) => {
  const meta = sectionWithProps({
    attachment: { type: "string", title: "Attachment", format: "file-uri" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await expect(
    component.getByText("Drop a file or click to browse"),
  ).toBeVisible();
});

test("video-uri format → FileField video picker", async ({ mount }) => {
  const meta = sectionWithProps({
    clip: { type: "string", title: "Clip", format: "video-uri" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await expect(
    component.getByText("Drop a video here or click to browse"),
  ).toBeVisible();
});

test("array schema → Add item button", async ({ mount }) => {
  const meta = sectionWithProps({
    tags: {
      type: "array",
      title: "Tags",
      items: { type: "string" },
    },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await expect(
    component.getByRole("button", { name: "Add item" }),
  ).toBeVisible();
});

test("object schema → collapsible toggle button with label", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    seo: {
      type: "object",
      title: "Seo",
      properties: {
        description: { type: "string", title: "Description" },
      },
    },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await expect(component.getByRole("button", { name: "Seo" })).toBeVisible();
});

test("color-input format → native color input", async ({ mount }) => {
  const meta = sectionWithProps({
    accent: { type: "string", title: "Accent", format: "color-input" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await expect(component.locator('input[type="color"]')).toBeVisible();
});

// @decocms/start's schema generator maps the `Color` widget alias to
// format: "color", so deco sites emit "color" rather than our "color-input".
test("color format → native color input", async ({ mount }) => {
  const meta = sectionWithProps({
    accent: { type: "string", title: "Accent", format: "color" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await expect(component.locator('input[type="color"]')).toBeVisible();
});

test("date format → native date input", async ({ mount }) => {
  const meta = sectionWithProps({
    publishedAt: { type: "string", title: "Published At", format: "date" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const input = component.getByLabel("Published At");
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("type", "date");
});

test("date-time format → native datetime-local input", async ({ mount }) => {
  const meta = sectionWithProps({
    startsAt: { type: "string", title: "Starts At", format: "date-time" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const input = component.getByLabel("Starts At");
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("type", "datetime-local");
});

test("textarea format → textarea element", async ({ mount }) => {
  const meta = sectionWithProps({
    body: { type: "string", title: "Body", format: "textarea" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const textarea = component.locator("textarea#body");
  await expect(textarea).toBeVisible();
});
