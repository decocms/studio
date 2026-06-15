import { expect, test } from "@playwright/experimental-ct-react";
import { SchemaFormHarness } from "../harness/schema-form-harness";
import { sectionWithProps, TEST_RESOLVE_TYPE } from "../harness/fixtures";
import { readFormValue } from "../harness/ct-utils";

test("renders an unchecked switch by default", async ({ mount }) => {
  const meta = sectionWithProps({
    enabled: { type: "boolean", title: "Enabled" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const sw = component.getByLabel("Enabled");
  await expect(sw).toBeVisible();
  await expect(sw).not.toBeChecked();
});

test("getByLabel returns the role=switch element", async ({ mount }) => {
  const meta = sectionWithProps({
    enabled: { type: "boolean", title: "Enabled" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const sw = component.getByLabel("Enabled");
  await expect(sw).toHaveRole("switch");
});

test("clicking an unchecked switch sets the value to true", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    enabled: { type: "boolean", title: "Enabled" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const sw = component.getByLabel("Enabled");
  await sw.click();

  await expect.poll(() => readFormValue(component)).toEqual({ enabled: true });
  await expect(sw).toBeChecked();
});

test("an initial true value renders a checked switch", async ({ mount }) => {
  const meta = sectionWithProps({
    enabled: { type: "boolean", title: "Enabled" },
  });
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{ enabled: true }}
    />,
  );

  const sw = component.getByLabel("Enabled");
  await expect(sw).toBeChecked();
});

test("clicking a checked switch sets the value to false", async ({ mount }) => {
  const meta = sectionWithProps({
    enabled: { type: "boolean", title: "Enabled" },
  });
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{ enabled: true }}
    />,
  );

  const sw = component.getByLabel("Enabled");
  await expect(sw).toBeChecked();
  await sw.click();

  await expect.poll(() => readFormValue(component)).toEqual({ enabled: false });
  await expect(sw).not.toBeChecked();
});

test("renders the schema description", async ({ mount }) => {
  const meta = sectionWithProps({
    enabled: {
      type: "boolean",
      title: "Enabled",
      description: "Toggle this feature on or off",
    },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await expect(
    component.getByText("Toggle this feature on or off"),
  ).toBeVisible();
});

test("toggling on then off round-trips back to false", async ({ mount }) => {
  const meta = sectionWithProps({
    enabled: { type: "boolean", title: "Enabled" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const sw = component.getByLabel("Enabled");
  await sw.click();
  await expect.poll(() => readFormValue(component)).toEqual({ enabled: true });

  await sw.click();
  await expect.poll(() => readFormValue(component)).toEqual({ enabled: false });
  await expect(sw).not.toBeChecked();
});

test("humanizes the field key when no title is provided", async ({ mount }) => {
  const meta = sectionWithProps({
    isFeatured: { type: "boolean" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const sw = component.getByLabel("Is Featured");
  await expect(sw).toBeVisible();
  await expect(sw).not.toBeChecked();

  await sw.click();
  await expect
    .poll(() => readFormValue(component))
    .toEqual({ isFeatured: true });
});
