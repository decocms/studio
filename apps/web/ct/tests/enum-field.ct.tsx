import { expect, test } from "@playwright/experimental-ct-react";
import { SchemaFormHarness } from "../harness/schema-form-harness";
import { sectionWithProps, TEST_RESOLVE_TYPE } from "../harness/fixtures";
import { readFormValue } from "../harness/ct-utils";

test("string enum renders a combobox trigger", async ({ mount }) => {
  const meta = sectionWithProps({
    size: { type: "string", enum: ["sm", "md", "lg"], title: "Size" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const trigger = component.getByRole("combobox");
  await expect(trigger).toBeVisible();
  await expect(component.getByText("Size")).toBeVisible();
});

test("string enum: open and pick an option round-trips its value", async ({
  mount,
  page,
}) => {
  const meta = sectionWithProps({
    size: { type: "string", enum: ["sm", "md", "lg"], title: "Size" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await component.getByRole("combobox").click();
  await page.getByRole("option", { name: "md" }).click();

  await expect.poll(() => readFormValue(component)).toEqual({ size: "md" });
});

test("string enum: each option is selectable", async ({ mount, page }) => {
  const meta = sectionWithProps({
    size: { type: "string", enum: ["sm", "md", "lg"], title: "Size" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await component.getByRole("combobox").click();
  await page.getByRole("option", { name: "sm" }).click();
  await expect.poll(() => readFormValue(component)).toEqual({ size: "sm" });

  await component.getByRole("combobox").click();
  await page.getByRole("option", { name: "lg" }).click();
  await expect.poll(() => readFormValue(component)).toEqual({ size: "lg" });
});

test("string enum: initial value is shown on the trigger", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    size: { type: "string", enum: ["sm", "md", "lg"], title: "Size" },
  });
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{ size: "lg" }}
    />,
  );

  await expect(component.getByRole("combobox")).toHaveText("lg");
});

test("string enum: initial value can be changed via the picker", async ({
  mount,
  page,
}) => {
  const meta = sectionWithProps({
    size: { type: "string", enum: ["sm", "md", "lg"], title: "Size" },
  });
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{ size: "lg" }}
    />,
  );

  await component.getByRole("combobox").click();
  await page.getByRole("option", { name: "sm" }).click();

  await expect.poll(() => readFormValue(component)).toEqual({ size: "sm" });
  await expect(component.getByRole("combobox")).toHaveText("sm");
});

test("numeric enum: picking an option yields a NUMBER, not a string", async ({
  mount,
  page,
}) => {
  const meta = sectionWithProps({
    size: { type: "number", enum: [1, 2, 3] },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await component.getByRole("combobox").click();
  await page.getByRole("option", { name: "2" }).click();

  await expect.poll(() => readFormValue(component)).toEqual({ size: 2 });
});

test("numeric enum: initial numeric value is shown on the trigger", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    size: { type: "number", enum: [1, 2, 3] },
  });
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{ size: 3 }}
    />,
  );

  await expect(component.getByRole("combobox")).toHaveText("3");
});

test("empty-string enum: picking a non-empty option works", async ({
  mount,
  page,
}) => {
  const meta = sectionWithProps({
    size: { type: "string", enum: ["", "a"] },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await component.getByRole("combobox").click();
  await page.getByRole("option", { name: "a" }).click();

  await expect.poll(() => readFormValue(component)).toEqual({ size: "a" });
});

test("empty-string enum: both options are present in the menu", async ({
  mount,
  page,
}) => {
  const meta = sectionWithProps({
    size: { type: "string", enum: ["", "a"] },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await component.getByRole("combobox").click();
  await expect(page.getByRole("option")).toHaveCount(2);
});

test("empty-string enum: selecting the empty option yields an empty string", async ({
  mount,
  page,
}) => {
  const meta = sectionWithProps({
    size: { type: "string", enum: ["", "a"] },
  });
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{ size: "a" }}
    />,
  );

  // The first option corresponds to the empty-string enum entry.
  await component.getByRole("combobox").click();
  await page.getByRole("option").first().click();

  await expect.poll(() => readFormValue(component)).toEqual({ size: "" });
});

test("enum: description renders next to the label", async ({ mount }) => {
  const meta = sectionWithProps({
    size: {
      type: "string",
      enum: ["sm", "md", "lg"],
      title: "Size",
      description: "Pick a size for the section",
    },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await expect(
    component.getByText("Pick a size for the section"),
  ).toBeVisible();
});

test("enum: label falls back to the humanized key when no title", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    textAlign: { type: "string", enum: ["left", "center", "right"] },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await expect(component.getByText("Text Align")).toBeVisible();
});
