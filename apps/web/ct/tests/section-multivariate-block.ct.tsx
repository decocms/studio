import { expect, test } from "@playwright/experimental-ct-react";
import { SchemaFormHarness } from "../harness/schema-form-harness";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";

/**
 * A saved/global block whose content is `website/flags/multivariate/section.ts`
 * (a section wrapped in variants) must render the VARIANT editor — a rule
 * matcher + per-variant inner field — not the generic "Item 1 / Item 2" array
 * editor. Regression net for the section-multivariate wrapper dispatch in
 * SchemaForm.
 */

const SECTION_MULTIVARIATE = "website/flags/multivariate/section.ts";
const HEADER = "site/sections/Header.tsx";

/**
 * Meta with the section-multivariate flag schema plus the inner section it
 * wraps. The flag's variant `value` type is left unresolved (a bare object) —
 * mirroring how schema depth limits often leave the nested section type
 * unresolved — so the inner field is resolved from the value's own
 * `__resolveType` (the realistic path).
 */
function multivariateMeta(): LiveMeta {
  const flagSchema: Record<string, unknown> = {
    type: "object",
    properties: {
      variants: {
        type: "array",
        items: {
          type: "object",
          properties: {
            value: { type: "object" },
            rule: { type: "object", properties: {} },
          },
        },
      },
    },
  };
  const headerSchema: Record<string, unknown> = {
    type: "object",
    properties: { title: { type: "string", title: "Heading" } },
  };
  return {
    manifest: {
      blocks: {
        sections: {
          [SECTION_MULTIVARIATE]: flagSchema,
          [HEADER]: headerSchema,
        },
      },
    },
    schema: {},
  };
}

const wrapperValue = {
  __resolveType: SECTION_MULTIVARIATE,
  variants: [
    {
      value: { __resolveType: HEADER, title: "Semana Granado" },
      rule: { __resolveType: "website/matchers/date.ts" },
    },
    {
      value: { __resolveType: HEADER, title: "Default" },
      rule: { __resolveType: "website/matchers/always.ts" },
    },
  ],
};

test("section-multivariate wrapper → variant editor (rule + inner field)", async ({
  mount,
}) => {
  const component = await mount(
    <SchemaFormHarness
      meta={multivariateMeta()}
      resolveType={SECTION_MULTIVARIATE}
      initialValue={wrapperValue}
    />,
  );

  // Variant editor chrome: the per-variant "Rule" matcher label.
  await expect(component.getByText("Rule", { exact: true })).toBeVisible();

  // The inner variant value renders as its own field (first variant selected).
  const heading = component.getByLabel("Heading");
  await expect(heading).toBeVisible();
  await expect(heading).toHaveValue("Semana Granado");
});

test("section-multivariate wrapper → NOT the generic array editor", async ({
  mount,
}) => {
  const component = await mount(
    <SchemaFormHarness
      meta={multivariateMeta()}
      resolveType={SECTION_MULTIVARIATE}
      initialValue={wrapperValue}
    />,
  );

  // Generic ArrayField would surface an "Add item" button and "Item N" rows.
  await expect(component.getByRole("button", { name: "Add item" })).toHaveCount(
    0,
  );
  await expect(component.getByText("Item 1", { exact: true })).toHaveCount(0);
});
