import { expect, test } from "@playwright/experimental-ct-react";
import { SchemaFormHarness } from "../harness/schema-form-harness";
import { sectionWithProps, TEST_RESOLVE_TYPE } from "../harness/fixtures";
import { hoverFieldDescription, readFormValue } from "../harness/ct-utils";

const ctaSchema = {
  type: "object",
  title: "CTA",
  properties: {
    text: { type: "string", title: "Text" },
    href: { type: "string", title: "Href" },
  },
} as const;

test("nested object is collapsed by default — nested field not visible", async ({
  mount,
}) => {
  const meta = sectionWithProps({ cta: ctaSchema });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  // The CTA toggle button is present...
  const toggle = component.getByRole("button", { name: "CTA" });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // ...but the nested "Text" field is not rendered while collapsed.
  await expect(component.getByLabel("Text")).toHaveCount(0);
});

test("clicking the CTA toggle expands nested fields (aria-expanded true)", async ({
  mount,
}) => {
  const meta = sectionWithProps({ cta: ctaSchema });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const toggle = component.getByRole("button", { name: "CTA" });
  await toggle.click();

  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(component.getByLabel("Text")).toBeVisible();
  await expect(component.getByLabel("Href")).toBeVisible();
});

test("editing a nested field writes a nested value", async ({ mount }) => {
  const meta = sectionWithProps({ cta: ctaSchema });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await component.getByRole("button", { name: "CTA" }).click();

  const textInput = component.getByLabel("Text");
  await expect(textInput).toBeVisible();
  // Nested input id == path == "cta.text".
  await expect(textInput).toHaveAttribute("id", "cta.text");

  await textInput.fill("Click");

  await expect
    .poll(() => readFormValue(component))
    .toEqual({ cta: { text: "Click" } });
});

test("editing two nested fields accumulates into one object", async ({
  mount,
}) => {
  const meta = sectionWithProps({ cta: ctaSchema });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await component.getByRole("button", { name: "CTA" }).click();

  await component.getByLabel("Text").fill("Click");
  await expect
    .poll(() => readFormValue(component))
    .toEqual({ cta: { text: "Click" } });

  await component.getByLabel("Href").fill("/go");
  await expect
    .poll(() => readFormValue(component))
    .toEqual({ cta: { text: "Click", href: "/go" } });
});

test("object description is shown as a help tooltip", async ({
  mount,
  page,
}) => {
  const meta = sectionWithProps({
    cta: {
      type: "object",
      title: "CTA",
      description: "Call to action button",
      properties: {
        text: { type: "string", title: "Text" },
      },
    },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await expect(component.getByText("Call to action button")).not.toBeVisible();
  await expect(
    await hoverFieldDescription(
      component,
      page,
      "CTA",
      "Call to action button",
    ),
  ).toBeVisible();
});

test("pre-populated nested object renders existing value once expanded", async ({
  mount,
}) => {
  const meta = sectionWithProps({ cta: ctaSchema });
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{ cta: { text: "Buy now", href: "/cart" } }}
    />,
  );

  await component.getByRole("button", { name: "CTA" }).click();

  await expect(component.getByLabel("Text")).toHaveValue("Buy now");
  await expect(component.getByLabel("Href")).toHaveValue("/cart");
});

test("deep nesting: object inside object, edit leaf writes a deep value", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    a: {
      type: "object",
      title: "A",
      properties: {
        b: {
          type: "object",
          title: "B",
          properties: {
            c: { type: "string", title: "C" },
          },
        },
      },
    },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  // Inner field hidden until both levels are expanded.
  await expect(component.getByLabel("C")).toHaveCount(0);

  // Expand outer object.
  const outer = component.getByRole("button", { name: "A" });
  await outer.click();
  await expect(outer).toHaveAttribute("aria-expanded", "true");

  // Inner object toggle now visible; still no leaf.
  const inner = component.getByRole("button", { name: "B" });
  await expect(inner).toBeVisible();
  await expect(component.getByLabel("C")).toHaveCount(0);

  // Expand inner object.
  await inner.click();
  await expect(inner).toHaveAttribute("aria-expanded", "true");

  const leaf = component.getByLabel("C");
  await expect(leaf).toBeVisible();
  // Deep path id == "a.b.c".
  await expect(leaf).toHaveAttribute("id", "a.b.c");

  await leaf.fill("x");

  await expect
    .poll(() => readFormValue(component))
    .toEqual({ a: { b: { c: "x" } } });
});

test("collapsing an expanded object hides its nested fields again", async ({
  mount,
}) => {
  const meta = sectionWithProps({ cta: ctaSchema });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const toggle = component.getByRole("button", { name: "CTA" });
  await toggle.click();
  await expect(component.getByLabel("Text")).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(component.getByLabel("Text")).toHaveCount(0);
});
