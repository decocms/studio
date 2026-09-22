import { expect, test } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import { readBreadcrumb, readFormValue } from "../harness/ct-utils";
import { TEST_RESOLVE_TYPE } from "../harness/fixtures";
import { MultivariateFieldHarness } from "../harness/multivariate-field-harness";

const MULTIVARIATE = "website/flags/multivariate/string.ts";
const HOST_MATCHER = "website/matchers/host.ts";
const ALWAYS_MATCHER = "website/matchers/always.ts";

const sectionSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    announcement: {
      title: "Announcement",
      anyOf: [
        { type: "string" },
        {
          type: "object",
          properties: {
            __resolveType: { type: "string", enum: [MULTIVARIATE] },
            variants: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  value: { type: "string" },
                  rule: { type: "object" },
                },
              },
            },
          },
        },
      ],
    },
  },
};
const matcherSchema: Record<string, unknown> = {
  type: "object",
  properties: { includes: { type: "string", title: "Hostname" } },
};
const meta: LiveMeta = {
  manifest: {
    blocks: {
      sections: { [TEST_RESOLVE_TYPE]: sectionSchema },
      matchers: { [HOST_MATCHER]: matcherSchema },
    },
  },
  schema: {},
};
const initialValue = {
  announcement: {
    __resolveType: MULTIVARIATE,
    variants: [
      {
        rule: { __resolveType: HOST_MATCHER, includes: "campaign.example" },
        value: "Campaign message",
      },
      {
        rule: { __resolveType: ALWAYS_MATCHER },
        value: "Default message",
      },
    ],
  },
};

async function setLayout(page: Page, compactPageLayout: boolean | undefined) {
  await page.evaluate(
    ({ key, compactPageLayout }) => {
      localStorage.setItem(key, JSON.stringify({ compactPageLayout }));
    },
    { key: LOCALSTORAGE_KEYS.preferences(), compactPageLayout },
  );
}

for (const compactPageLayout of [undefined, false]) {
  test(`classic (${compactPageLayout === undefined ? "missing preference" : "disabled"}): variant values and rules remain editable inline`, async ({
    mount,
    page,
  }) => {
    await setLayout(page, compactPageLayout);
    const component = await mount(
      <MultivariateFieldHarness
        meta={meta}
        resolveType={TEST_RESOLVE_TYPE}
        initialValue={initialValue}
      />,
    );

    await expect(component.getByText("Rule", { exact: true })).toBeVisible();
    await expect(component.getByLabel("Announcement")).toHaveValue(
      "Campaign message",
    );
    await expect(component.getByLabel("Hostname")).toHaveValue(
      "campaign.example",
    );
    await expect(component.getByTestId("form-header")).toBeEmpty();
    await expect.poll(() => readBreadcrumb(component)).toEqual([]);

    await component.getByLabel("Announcement").fill("Updated campaign");
    await component.getByLabel("Hostname").fill("sale.example");
    await component.getByText("Default", { exact: true }).click();
    await expect(component.getByLabel("Announcement")).toHaveValue(
      "Default message",
    );
    await component.getByLabel("Announcement").fill("Updated default");

    await expect
      .poll(() => readFormValue(component))
      .toEqual({
        announcement: {
          __resolveType: MULTIVARIATE,
          variants: [
            {
              rule: { __resolveType: HOST_MATCHER, includes: "sale.example" },
              value: "Updated campaign",
            },
            {
              rule: { __resolveType: ALWAYS_MATCHER },
              value: "Updated default",
            },
          ],
        },
      });
    await expect.poll(() => readBreadcrumb(component)).toEqual([]);
  });
}

test("compact: opens a field, selects and manages variants, then restores the classic editor while focused", async ({
  mount,
  page,
}) => {
  await setLayout(page, true);
  const component = await mount(
    <MultivariateFieldHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={initialValue}
    />,
  );
  const header = component.getByTestId("form-header");

  await expect(component.getByLabel("Announcement")).toHaveCount(0);
  await component
    .getByRole("button", { name: "Variants of Announcement" })
    .click();
  await expect.poll(() => readBreadcrumb(component)).toEqual(["Announcement"]);
  await expect(component.getByLabel("Announcement")).toHaveValue(
    "Campaign message",
  );
  await expect(component.getByLabel("Hostname")).toHaveCount(0);

  await header.getByRole("button", { name: "campaign.example" }).click();
  await page.getByRole("menuitem", { name: "Default", exact: true }).click();
  await expect(component.getByLabel("Announcement")).toHaveValue(
    "Default message",
  );
  await component.getByLabel("Announcement").fill("Compact edit");

  await header.getByRole("button", { name: "Default", exact: true }).click();
  await page.getByRole("menuitem", { name: "Manage variants" }).click();
  await expect
    .poll(() => readBreadcrumb(component))
    .toEqual(["Announcement", "Variants"]);
  await expect(header).toBeEmpty();
  await expect(component.getByLabel("Announcement")).toHaveCount(0);
  await expect(
    component.getByRole("button", { name: "Add variant", exact: true }),
  ).toBeVisible();

  await component.getByText("campaign.example", { exact: true }).click();
  await expect.poll(() => readBreadcrumb(component)).toEqual(["Announcement"]);
  await expect(component.getByLabel("Announcement")).toHaveValue(
    "Campaign message",
  );

  await component.getByRole("button", { name: "Use classic layout" }).click();
  await expect(header).toBeEmpty();
  await expect(component.getByText("Rule", { exact: true })).toBeVisible();
  await expect(component.getByLabel("Hostname")).toHaveValue(
    "campaign.example",
  );
  await component.getByText("Default", { exact: true }).click();
  await expect(component.getByLabel("Announcement")).toHaveValue(
    "Compact edit",
  );
  await expect
    .poll(() => readFormValue(component))
    .toEqual({
      announcement: {
        ...initialValue.announcement,
        variants: [
          initialValue.announcement.variants[0],
          { rule: { __resolveType: ALWAYS_MATCHER }, value: "Compact edit" },
        ],
      },
    });
});
