import { expect, test } from "@playwright/experimental-ct-react";
import { SchemaFormHarness } from "../harness/schema-form-harness";
import { sectionWithProps, TEST_RESOLVE_TYPE } from "../harness/fixtures";
import { readFormValue } from "../harness/ct-utils";
import { CT_PROJECT_DEFAULTS_ON_CREATE_ONLY } from "../harness/stubs/use-virtual-mcp";

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

test("by default, opening a form writes its missing defaults", async ({
  mount,
}) => {
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      virtualMcpId="ct-project"
    />,
  );

  await expect
    .poll(() => readFormValue(component))
    .toMatchObject({ title: "Hello" });
});

test("defaults only on creation: opening writes nothing, and editing one field writes only that field", async ({
  mount,
}) => {
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      virtualMcpId={CT_PROJECT_DEFAULTS_ON_CREATE_ONLY}
      initialValue={{ subtitle: "Old", links: [{ label: "A" }] }}
    />,
  );

  await expect(component.getByLabel("Title", { exact: true })).toHaveValue(
    "Hello",
  );
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
      virtualMcpId={CT_PROJECT_DEFAULTS_ON_CREATE_ONLY}
      initialValue={{ links: [{ label: "A" }] }}
    />,
  );

  await component.getByRole("button", { name: "Add item" }).click();

  await expect
    .poll(() => readFormValue(component))
    .toEqual({ links: [{ label: "A" }, { display: true }] });
});
