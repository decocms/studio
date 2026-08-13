import { expect, test } from "@playwright/experimental-ct-react";
import type { Locator } from "@playwright/test";
import { SchemaFormHarness } from "../harness/schema-form-harness";
import { sectionWithProps, TEST_RESOLVE_TYPE } from "../harness/fixtures";
import {
  openRowActionsMenu,
  readBreadcrumb,
  readFormValue,
} from "../harness/ct-utils";

const itemRow = (component: Locator, label: string) =>
  component.getByRole("button").filter({ hasText: label });

/**
 * Reproduces "duplicate a SEO description, edit it, and it snaps back to the one
 * it was duplicated from". The DescriptionSEOPLP rows read `/feminino$`, `/ab$`,
 * … from a URL matcher nested TWO levels deep (a `matchers` array inside each
 * item), so the item's `titleBy` reads `matcher.matchers.0.pattern`. Duplicating
 * clones that derived label; editing the deep matcher of the copy churns it —
 * and its crumb's re-sync races the nested trail rebuild — so resolution used to
 * fall back to a label search and snap to the first colliding item (the
 * original). Both must keep the editor pinned to the item being edited.
 */
const seoArrayProps = {
  seoDescriptions: {
    type: "array",
    title: "Descrições para SEO",
    items: {
      type: "object",
      title: "SEO Description",
      titleBy: "{{{matcher.matchers.0.pattern}}}",
      properties: {
        matcher: {
          type: "object",
          title: "Configuração de exibição",
          properties: {
            matchers: {
              type: "array",
              title: "Matchers",
              items: {
                type: "object",
                title: "Padrão de URL",
                titleBy: "{{{pattern}}}",
                properties: {
                  pattern: { type: "string", title: "Padrão de URL" },
                },
              },
            },
          },
        },
        description: { type: "string", title: "Descrição" },
      },
    },
  },
};

const seoItem = (pattern: string, description: string) => ({
  matcher: { matchers: [{ pattern }] },
  description,
});

/** Open the item row `label`, expand its matcher section, open the matcher row. */
const drillToPattern = async (component: Locator, label: string, nth = 0) => {
  await itemRow(component, label).nth(nth).click();
  await itemRow(component, "Configuração de exibição").click();
  await itemRow(component, label).click();
};

test("duplicate a deeply-labelled item, edit the copy's matcher — stays on the copy", async ({
  mount,
  page,
}) => {
  const meta = sectionWithProps(seoArrayProps);
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{ seoDescriptions: [seoItem("/feminino$", "orig")] }}
    />,
  );

  await openRowActionsMenu(component, "/feminino$");
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect
    .poll(() => readFormValue(component))
    .toEqual({
      seoDescriptions: [
        seoItem("/feminino$", "orig"),
        seoItem("/feminino$", "orig"),
      ],
    });

  // Open the COPY (second row) and rename its matcher pattern.
  await drillToPattern(component, "/feminino$", 1);
  const patternInput = component.getByLabel("Padrão de URL");
  await expect(patternInput).toHaveAttribute(
    "id",
    "seoDescriptions.1.matcher.matchers.0.pattern",
  );
  await patternInput.fill("/nova$");

  // Editing stays on the copy (index 1), not snapped to the original (index 0).
  await expect(component.getByLabel("Padrão de URL")).toHaveAttribute(
    "id",
    "seoDescriptions.1.matcher.matchers.0.pattern",
  );
  await expect
    .poll(() => readFormValue(component))
    .toEqual({
      seoDescriptions: [
        seoItem("/feminino$", "orig"),
        seoItem("/nova$", "orig"),
      ],
    });

  // Item crumb tracks the edit; it must not freeze at the duplicated-from label.
  await expect
    .poll(() => readBreadcrumb(component))
    .not.toContain("/feminino$");
});

test("editing a deeply-labelled item's matcher to collide with an existing item stays put", async ({
  mount,
}) => {
  const meta = sectionWithProps(seoArrayProps);
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{
        seoDescriptions: [
          seoItem("/feminino$", "a"),
          seoItem("/masculino$", "b"),
        ],
      }}
    />,
  );

  await drillToPattern(component, "/masculino$");
  const patternInput = component.getByLabel("Padrão de URL");
  await expect(patternInput).toHaveAttribute(
    "id",
    "seoDescriptions.1.matcher.matchers.0.pattern",
  );

  await patternInput.fill("/feminino$");

  // Renamed to collide with item 0 — must stay on index 1, not snap to index 0.
  await expect(component.getByLabel("Padrão de URL")).toHaveAttribute(
    "id",
    "seoDescriptions.1.matcher.matchers.0.pattern",
  );
  await expect
    .poll(() => readFormValue(component))
    .toEqual({
      seoDescriptions: [seoItem("/feminino$", "a"), seoItem("/feminino$", "b")],
    });
});
