import { expect, test } from "@playwright/experimental-ct-react";
import { SchemaFormHarness } from "../harness/schema-form-harness";
import { sectionWithProps, TEST_RESOLVE_TYPE } from "../harness/fixtures";
import { readFormValue } from "../harness/ct-utils";

test("renders a string field and round-trips typed value", async ({
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
  await input.fill("Hello world");

  await expect
    .poll(() => readFormValue(component))
    .toEqual({ title: "Hello world" });
});

test("returns null render for a schema with no properties", async ({
  mount,
}) => {
  const meta = sectionWithProps({});
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );
  await expect(component.getByTestId("resolve-null")).toBeVisible();
});
