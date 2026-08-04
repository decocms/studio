import { expect, test } from "@playwright/experimental-ct-react";
import { SchemaFormHarness } from "../harness/schema-form-harness";
import { sectionWithProps, TEST_RESOLVE_TYPE } from "../harness/fixtures";
import { hoverFieldDescription } from "../harness/ct-utils";

/**
 * Schema-resolution edge cases that change WHAT renders: nullable unions that
 * must preserve their leaf `format`, enum-from-const unions, hidden/internal
 * property filtering, and the "no editable fields" empty state. Each test feeds
 * a raw JSON Schema through resolveSchema → SchemaForm (via SchemaFormHarness)
 * and asserts the resulting widget, NOT a generic text box.
 */

test("nullable image union resolves to an ImageField (not a text box)", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    hero: {
      anyOf: [
        { type: "string", format: "image-uri", title: "Hero image" },
        { type: "null" },
      ],
    },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  // ImageField empty-state: the image drop/browse button.
  await expect(
    component.getByRole("button", {
      name: "Drop an image or click to browse",
    }),
  ).toBeVisible();
  // The label comes from the union leaf's title.
  await expect(component.getByText("Hero image")).toBeVisible();
  // ImageField exposes a url <Input id={path}>, so getByLabel finds it.
  const urlInput = component.getByLabel("Hero image");
  await expect(urlInput).toBeVisible();
  await expect(urlInput).toHaveAttribute("type", "url");
});

test("nullable image union round-trips a typed url", async ({ mount }) => {
  const meta = sectionWithProps({
    hero: {
      anyOf: [
        { type: "string", format: "image-uri", title: "Hero image" },
        { type: "null" },
      ],
    },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await component
    .getByLabel("Hero image")
    .fill("https://example.com/banner.png");

  await expect
    .poll(() => component.getByTestId("form-value").textContent())
    .toContain("https://example.com/banner.png");
});

test("nullable file union resolves to a FileField", async ({ mount }) => {
  const meta = sectionWithProps({
    asset: {
      anyOf: [
        { type: "string", format: "file-uri", title: "Asset" },
        { type: "null" },
      ],
    },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  // FileField empty-state: the file drop/browse button.
  await expect(
    component.getByRole("button", { name: "Drop a file or click to browse" }),
  ).toBeVisible();
  const urlInput = component.getByLabel("Asset");
  await expect(urlInput).toBeVisible();
  await expect(urlInput).toHaveAttribute("type", "url");
});

test("enum-from-const union resolves to an EnumField with all options", async ({
  mount,
  page,
}) => {
  const meta = sectionWithProps({
    variant: {
      title: "Variant",
      anyOf: [{ const: "a" }, { const: "b" }, { const: "c" }],
    },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  // EnumField renders a <Select> trigger (role=combobox), not a text box.
  const trigger = component.getByRole("combobox");
  await expect(trigger).toBeVisible();
  await trigger.click();

  // Options are portaled to document.body → query via page.
  await expect(page.getByRole("option", { name: "a" })).toBeVisible();
  await expect(page.getByRole("option", { name: "b" })).toBeVisible();
  await expect(page.getByRole("option", { name: "c" })).toBeVisible();
});

test("enum-from-const union round-trips the picked const value", async ({
  mount,
  page,
}) => {
  const meta = sectionWithProps({
    variant: {
      title: "Variant",
      anyOf: [{ const: "a" }, { const: "b" }, { const: "c" }],
    },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await component.getByRole("combobox").click();
  await page.getByRole("option", { name: "b" }).click();

  await expect
    .poll(() => component.getByTestId("form-value").textContent())
    .toContain('"variant":"b"');
});

test("hidden property (hide:true) is not rendered", async ({ mount }) => {
  const meta = sectionWithProps({
    visible: { type: "string", title: "Visible" },
    secret: { type: "string", hide: true, title: "Secret" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await expect(component.getByLabel("Visible")).toBeVisible();
  await expect(component.getByText("Secret")).toHaveCount(0);
  await expect(component.getByLabel("Secret")).toHaveCount(0);
});

test("__resolveType and @type are never rendered as fields", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    __resolveType: { type: "string", title: "Resolve Type" },
    "@type": { type: "string", title: "At Type" },
    title: { type: "string", title: "Title" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  // The real field renders.
  await expect(component.getByLabel("Title", { exact: true })).toBeVisible();
  // The internal deco props produce no input.
  await expect(component.getByLabel("Resolve Type")).toHaveCount(0);
  await expect(component.getByLabel("At Type")).toHaveCount(0);
  await expect(component.getByText("Resolve Type")).toHaveCount(0);
  await expect(component.getByText("At Type")).toHaveCount(0);
});

test("a section whose only field is hidden shows the empty-state message", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    secret: { type: "string", hide: true, title: "Secret" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  // resolveSchema keeps the hidden prop (so it does NOT return null), and
  // SchemaForm filters it out → the "No editable fields" empty state.
  await expect(component.getByTestId("resolve-null")).toHaveCount(0);
  await expect(
    component.getByText("No editable fields on this section."),
  ).toBeVisible();
});

test("all internal props hidden/filtered shows the empty-state message", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    __resolveType: { type: "string", title: "Resolve Type" },
    "@type": { type: "string", title: "At Type" },
    secret: { type: "string", hide: true, title: "Secret" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await expect(
    component.getByText("No editable fields on this section."),
  ).toBeVisible();
});

test("multiple string fields render all their labels", async ({ mount }) => {
  const meta = sectionWithProps({
    title: { type: "string", title: "Title" },
    subtitle: { type: "string", title: "Subtitle" },
    cta: { type: "string", title: "Call To Action" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await expect(component.getByLabel("Title", { exact: true })).toBeVisible();
  await expect(component.getByLabel("Subtitle")).toBeVisible();
  await expect(component.getByLabel("Call To Action")).toBeVisible();
});

test("field with no title is humanized into a label", async ({ mount }) => {
  const meta = sectionWithProps({
    heroSubtitle: { type: "string" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  // fieldDisplayLabel humanizes camelCase keys when no title is present.
  await expect(component.getByLabel("Hero Subtitle")).toBeVisible();
});

test("field description is shown as a help tooltip alongside the field", async ({
  mount,
  page,
}) => {
  const meta = sectionWithProps({
    title: {
      type: "string",
      title: "Title",
      description: "Shown in the page hero header.",
    },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await expect(component.getByLabel("Title", { exact: true })).toBeVisible();
  await expect(
    component.getByText("Shown in the page hero header."),
  ).not.toBeVisible();
  await expect(
    await hoverFieldDescription(
      component,
      page,
      "Title",
      "Shown in the page hero header.",
    ),
  ).toBeVisible();
});

test("nullable image union inherits the leaf description", async ({
  mount,
  page,
}) => {
  const meta = sectionWithProps({
    hero: {
      anyOf: [
        {
          type: "string",
          format: "image-uri",
          title: "Hero image",
          description: "Recommended 1600x900.",
        },
        { type: "null" },
      ],
    },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await expect(
    await hoverFieldDescription(
      component,
      page,
      "Hero image",
      "Recommended 1600x900.",
    ),
  ).toBeVisible();
  await expect(
    component.getByRole("button", {
      name: "Drop an image or click to browse",
    }),
  ).toBeVisible();
});
