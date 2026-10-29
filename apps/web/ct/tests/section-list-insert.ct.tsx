import { expect, test } from "@playwright/experimental-ct-react";
import type { Locator } from "@playwright/test";
import { SectionListHarness } from "../harness/section-list-harness";
import { readEvents } from "../harness/ct-utils";

/**
 * SectionList row menu — "Add section above/below" asks the editor to open the
 * picker at that row's position, instead of the page-level "Add section" that
 * drops the section before the footer. DropdownMenu content is portaled →
 * queried via `page`.
 */
const SECTIONS = [
  { __resolveType: "site/sections/Header/Header.tsx" },
  { __resolveType: "site/sections/Hero/Hero.tsx" },
  { __resolveType: "site/sections/Footer/Footer.tsx" },
];

async function openMenuFor(component: Locator, label: string) {
  await component.getByText(label, { exact: true }).hover();
  await component
    .getByText(label, { exact: true })
    .locator("xpath=ancestor::*[.//button[@aria-label='Section actions']][1]")
    .getByRole("button", { name: "Section actions", exact: true })
    .click();
}

test("'Add section above' asks for the row's own index", async ({
  mount,
  page,
}) => {
  const component = await mount(<SectionListHarness rawSections={SECTIONS} />);
  await openMenuFor(component, "Footer");
  await page.getByRole("menuitem", { name: "Add section above" }).click();
  await expect
    .poll(() => readEvents(component))
    .toEqual([{ type: "addAt", index: 2 }]);
});

test("'Add section below' asks for the index after the row", async ({
  mount,
  page,
}) => {
  const component = await mount(<SectionListHarness rawSections={SECTIONS} />);
  await openMenuFor(component, "Hero");
  await page.getByRole("menuitem", { name: "Add section below" }).click();
  await expect
    .poll(() => readEvents(component))
    .toEqual([{ type: "addAt", index: 2 }]);
});

test("no insert items when sections can't be added", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <SectionListHarness rawSections={SECTIONS} canAddSection={false} />,
  );
  await openMenuFor(component, "Hero");
  await expect(page.getByRole("menuitem", { name: "Duplicate" })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Add section above" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "Add section below" }),
  ).toHaveCount(0);
});
