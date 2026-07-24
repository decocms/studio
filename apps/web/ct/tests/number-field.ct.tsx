import { expect, test } from "@playwright/experimental-ct-react";
import { SchemaFormHarness } from "../harness/schema-form-harness";
import { sectionWithProps, TEST_RESOLVE_TYPE } from "../harness/fixtures";
import { readFormValue } from "../harness/ct-utils";

test("renders an input[type=number] and round-trips an integer value", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    count: { type: "number", title: "Count" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const input = component.getByLabel("Count");
  await expect(input).toBeVisible();
  // Uses a text input with a decimal inputMode so leading decimals ("0.4") can
  // be typed left-to-right without the browser/controlled-value collapsing "0.".
  await expect(input).toHaveAttribute("type", "text");
  await expect(input).toHaveAttribute("inputmode", "decimal");
  await input.fill("42");

  await expect.poll(() => readFormValue(component)).toEqual({ count: 42 });
});

test("stores number values as numbers, not strings", async ({ mount }) => {
  const meta = sectionWithProps({
    count: { type: "number", title: "Count" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await component.getByLabel("Count").fill("42");

  await expect
    .poll(async () => {
      const value = (await readFormValue(component)) as { count: unknown };
      return typeof value.count;
    })
    .toBe("number");
});

test("integer type behaves the same as number", async ({ mount }) => {
  const meta = sectionWithProps({
    count: { type: "integer", title: "Count" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const input = component.getByLabel("Count");
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("type", "text");
  await expect(input).toHaveAttribute("inputmode", "numeric");
  await input.fill("7");

  await expect.poll(() => readFormValue(component)).toEqual({ count: 7 });
});

test("accepts decimal values", async ({ mount }) => {
  const meta = sectionWithProps({
    count: { type: "number", title: "Count" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await component.getByLabel("Count").fill("3.14");

  await expect.poll(() => readFormValue(component)).toEqual({ count: 3.14 });
});

test("allows typing a leading decimal left-to-right (0.4)", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    count: { type: "number", title: "Count" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const input = component.getByLabel("Count");
  await input.fill(""); // start from empty, as the real matcher-rule form does
  // pressSequentially replays real keystrokes, unlike fill() which sets the
  // value atomically — this is what regressed with a controlled type=number.
  await input.pressSequentially("0.4");

  await expect(input).toHaveValue("0.4");
  await expect.poll(() => readFormValue(component)).toEqual({ count: 0.4 });
});

test("ignores non-numeric characters while typing", async ({ mount }) => {
  const meta = sectionWithProps({
    count: { type: "number", title: "Count" },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  const input = component.getByLabel("Count");
  await input.fill("");
  await input.pressSequentially("1a2b");

  await expect(input).toHaveValue("12");
  await expect.poll(() => readFormValue(component)).toEqual({ count: 12 });
});

test("clearing the input drops the key (onChange undefined)", async ({
  mount,
}) => {
  const meta = sectionWithProps({
    count: { type: "number", title: "Count" },
  });
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{ count: 5 }}
    />,
  );

  const input = component.getByLabel("Count");
  await expect(input).toHaveValue("5");
  await input.fill("");

  await expect.poll(() => readFormValue(component)).toEqual({});
});

test("reflects an initial value in the input", async ({ mount }) => {
  const meta = sectionWithProps({
    count: { type: "number", title: "Count" },
  });
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{ count: 99 }}
    />,
  );

  await expect(component.getByLabel("Count")).toHaveValue("99");
});

test("renders the schema description", async ({ mount }) => {
  const meta = sectionWithProps({
    count: {
      type: "number",
      title: "Count",
      description: "How many widgets to display",
    },
  });
  const component = await mount(
    <SchemaFormHarness meta={meta} resolveType={TEST_RESOLVE_TYPE} />,
  );

  await expect(
    component.getByText("How many widgets to display"),
  ).toBeVisible();
});
