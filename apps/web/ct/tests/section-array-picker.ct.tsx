import { expect, test } from "@playwright/experimental-ct-react";
import { SchemaFormPanelHarness } from "../harness/schema-form-panel-harness";
import { sectionWithProps, TEST_RESOLVE_TYPE } from "../harness/fixtures";
import {
  openRowActionsMenu,
  readEvents,
  readFormValue,
} from "../harness/ct-utils";

// A `sections`-keyed array field is a section picker (isSectionArrayField).
// Clicking "Add section" must route to the picker (onRequestAddSection) — but
// only when previewBaseUrl reached the field. The regression this guards: the
// prop was dropped by SchemaFormPanel, so the field always saw
// previewBaseUrl === undefined and fired the "start preview dev server" toast
// instead of the picker, even with the dev server up.
const sectionArrayMeta = () =>
  sectionWithProps({
    sections: {
      type: "array",
      title: "Sections",
      items: { type: "object", properties: {} },
    },
  });

test("section-array 'Add section' reaches the picker when previewBaseUrl is set", async ({
  mount,
}) => {
  const component = await mount(
    <SchemaFormPanelHarness
      meta={sectionArrayMeta()}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{}}
      previewBaseUrl="https://preview.example.com"
    />,
  );

  await component.getByRole("button", { name: "Add section" }).click();

  // The picker was requested; nothing was appended directly.
  await expect.poll(() => readEvents(component)).toEqual(["requestAddSection"]);
  await expect.poll(() => readFormValue(component)).toEqual({});
});

test("section-array 'Add section' is gated (no picker) when previewBaseUrl is absent", async ({
  mount,
}) => {
  const component = await mount(
    <SchemaFormPanelHarness
      meta={sectionArrayMeta()}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{}}
    />,
  );

  await component.getByRole("button", { name: "Add section" }).click();

  // The `!previewBaseUrl` guard fires the toast and does NOT request the picker.
  await expect.poll(() => readEvents(component)).toEqual([]);
  await expect.poll(() => readFormValue(component)).toEqual({});
});

// Inside a section (e.g. a search container's own sections list), the row
// menu's "Add section above/below" puts the picked section next to that row
// instead of at the end of the list.
const PICKED = "site/sections/Picked.tsx";
const twoSections = () => ({
  sections: [
    { __resolveType: "site/sections/First.tsx" },
    { __resolveType: "site/sections/Second.tsx" },
  ],
});

test("section-array row 'Add section above' inserts before that row", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <SchemaFormPanelHarness
      meta={sectionArrayMeta()}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={twoSections()}
      previewBaseUrl="https://preview.example.com"
      pickResolveType={PICKED}
    />,
  );

  await component.getByText("Sections", { exact: true }).click();
  await openRowActionsMenu(component, "Second");
  await page.getByRole("menuitem", { name: "Add section above" }).click();

  await expect
    .poll(() => readFormValue(component))
    .toEqual({
      sections: [
        { __resolveType: "site/sections/First.tsx" },
        { __resolveType: PICKED },
        { __resolveType: "site/sections/Second.tsx" },
      ],
    });
});

test("section-array row 'Add section below' inserts after that row", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <SchemaFormPanelHarness
      meta={sectionArrayMeta()}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={twoSections()}
      previewBaseUrl="https://preview.example.com"
      pickResolveType={PICKED}
    />,
  );

  await component.getByText("Sections", { exact: true }).click();
  await openRowActionsMenu(component, "First");
  await page.getByRole("menuitem", { name: "Add section below" }).click();

  await expect
    .poll(() => readFormValue(component))
    .toEqual({
      sections: [
        { __resolveType: "site/sections/First.tsx" },
        { __resolveType: PICKED },
        { __resolveType: "site/sections/Second.tsx" },
      ],
    });
});
