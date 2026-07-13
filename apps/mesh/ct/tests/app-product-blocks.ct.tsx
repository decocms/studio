import { expect, test } from "@playwright/experimental-ct-react";
import {
  AppProductCardBlockHarness,
  AppProductShelfBlockHarness,
} from "../harness/app-product-block-harness";
import { readFormValue } from "../harness/ct-utils";

/**
 * Regression guard + visual evidence for the studio PR #4302 fix: the
 * deco-cms/blog app's ProductCard/ProductShelf editors must route through
 * the shared `DynamicOptionsField` (searchable combobox hitting the
 * `productsByTerm` loader), not a raw text input for the `platform:kind:id`
 * ref. Network calls are mocked at the `/deco/invoke/...` boundary so this
 * runs without a live sandbox VM or commerce integration.
 */
const PRODUCT_OPTIONS = [
  {
    value: "vtex:product:151331",
    label: "Caixa Bauducco Wafer Deli 100g - R$ 8,90",
    image: "https://picsum.photos/seed/bauducco/80",
  },
  {
    value: "vtex:product:151332",
    label: "Chocolate Lacta 90g - R$ 6,50",
    image: "https://picsum.photos/seed/lacta/80",
  },
];

async function mockProductsByTerm(page: import("@playwright/test").Page) {
  await page.route(
    "**/deco/invoke/blog/loaders/options/productsByTerm.ts",
    (route) => route.fulfill({ json: PRODUCT_OPTIONS }),
  );
}

test("ProductCard renders the searchable product picker, not a text input", async ({
  mount,
  page,
}) => {
  await mockProductsByTerm(page);
  const component = await mount(<AppProductCardBlockHarness />);

  // No raw <input> for the product ref — a combobox trigger instead.
  await expect(page.locator("#app-product-card-ref")).toHaveCount(0);
  const trigger = component.getByRole("combobox");
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveText("Select...");

  await trigger.click();
  await expect(page.getByPlaceholder("Search...")).toBeVisible();
  await expect(page.getByRole("option", { name: /Bauducco/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Lacta/ })).toBeVisible();
  // Product thumbnails render inside the option list.
  await expect(page.locator('[role="option"] img')).toHaveCount(2);

  await page.screenshot({
    path: "ct/__screenshots__/product-card-picker-open.png",
  });
});

test("selecting a product persists the platform:kind:id ref", async ({
  mount,
  page,
}) => {
  await mockProductsByTerm(page);
  const component = await mount(<AppProductCardBlockHarness />);

  await component.getByRole("combobox").click();
  await page.getByRole("option", { name: /Bauducco/ }).click();

  await expect(component.getByRole("combobox")).toContainText("Bauducco");
  const value = await readFormValue(component);
  expect(value).toMatchObject({ product: "vtex:product:151331" });

  await page.screenshot({
    path: "ct/__screenshots__/product-card-selected.png",
  });
});

test("ProductShelf renders one picker per product reference", async ({
  mount,
  page,
}) => {
  await mockProductsByTerm(page);
  const component = await mount(
    <AppProductShelfBlockHarness
      initialProducts={["vtex:product:151331", ""]}
    />,
  );

  const combos = component.getByRole("combobox");
  await expect(combos).toHaveCount(2);
  // Before the picker is opened, the raw ref is shown as a plain fallback.
  await expect(combos.nth(0)).toHaveText("vtex:product:151331");
  await expect(combos.nth(1)).toHaveText("Select...");

  // Opening a picker resolves the raw ref to its labeled, imaged option.
  await combos.nth(0).click();
  await expect(page.getByRole("option", { name: /Bauducco/ })).toBeVisible();

  await page.screenshot({
    path: "ct/__screenshots__/product-shelf-pickers.png",
  });
});
