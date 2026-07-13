import { expect, test } from "@playwright/experimental-ct-react";
import {
  AppProductCardBlockHarness,
  AppProductShelfBlockHarness,
} from "../harness/app-product-block-harness";
import { readFormValue } from "../harness/ct-utils";

/**
 * Regression guard for the studio PR #4302 fix: the deco-cms/blog app's
 * ProductCard/ProductShelf editors must route through the shared
 * `DynamicOptionsField` (searchable combobox hitting the `productsByTerm`
 * loader), not a raw text input for the `platform:kind:id` ref.
 *
 * The mocked `/deco/invoke/...` responses below mirror the real shape
 * `blog/utils/productResolver.ts#toOption` produces for each commerce
 * platform (`{ value: "<platform>:<kind>:<id>", label: "<name> - <price>",
 * image: "<platform CDN url>" }`), formatted like `getProductPrices`
 * (Intl.NumberFormat "pt-BR"/BRL) actually renders them — VTEX is the
 * platform `detectPlatform` probes first and the one every site in
 * production currently runs on.
 */
const VTEX_OPTIONS = [
  {
    value: "vtex:product:151331",
    label: "Caixa Bauducco Wafer Deli 100g - R$ 8,90",
    image:
      "https://acmestore.vteximg.com.br/arquivos/ids/151331-500-500/bauducco-wafer-deli-100g.jpg",
  },
  {
    value: "vtex:product:151332",
    label: "Chocolate Lacta ao Leite 90g - R$ 6,50",
    image:
      "https://acmestore.vteximg.com.br/arquivos/ids/151332-500-500/lacta-ao-leite-90g.jpg",
  },
];

// A Shopify-detected site returns `shopify:handle:<slug>` refs instead of
// VTEX's `vtex:product:<id>` — the picker must stay platform-agnostic, since
// AppProductCardBlock/AppProductShelfBlock only ever consume the resolved
// `{ value, label, image }` shape, never the ref format itself.
const SHOPIFY_OPTIONS = [
  {
    value: "shopify:handle:tenis-runner-pro",
    label: "Tênis Runner Pro - R$ 349,90",
    image: "https://cdn.shopify.com/s/files/1/0001/products/runner-pro.jpg",
  },
];

async function mockProductsByTerm(
  page: import("@playwright/test").Page,
  options: unknown[],
) {
  await page.route(
    "**/deco/invoke/blog/loaders/options/productsByTerm.ts",
    (route) => route.fulfill({ json: options }),
  );
}

test("ProductCard renders the searchable product picker, not a text input", async ({
  mount,
  page,
}) => {
  await mockProductsByTerm(page, VTEX_OPTIONS);
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
});

test("selecting a VTEX product persists the platform:kind:id ref", async ({
  mount,
  page,
}) => {
  await mockProductsByTerm(page, VTEX_OPTIONS);
  const component = await mount(<AppProductCardBlockHarness />);

  await component.getByRole("combobox").click();
  await page.getByRole("option", { name: /Bauducco/ }).click();

  await expect(component.getByRole("combobox")).toContainText("Bauducco");
  const value = await readFormValue(component);
  expect(value).toMatchObject({ product: "vtex:product:151331" });
});

test("selecting a Shopify product persists its shopify:handle ref (platform-agnostic UI)", async ({
  mount,
  page,
}) => {
  await mockProductsByTerm(page, SHOPIFY_OPTIONS);
  const component = await mount(<AppProductCardBlockHarness />);

  await component.getByRole("combobox").click();
  await page.getByRole("option", { name: /Runner Pro/ }).click();

  const value = await readFormValue(component);
  expect(value).toMatchObject({
    product: "shopify:handle:tenis-runner-pro",
  });
});

test("ProductShelf renders one picker per product reference and resolves each", async ({
  mount,
  page,
}) => {
  await mockProductsByTerm(page, VTEX_OPTIONS);
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

  // Adding a second product and picking it appends to the string[] ref list.
  await page.keyboard.press("Escape");
  await component
    .getByRole("button", { name: "Add product reference" })
    .click();
  await expect(combos).toHaveCount(3);
  await combos.nth(2).click();
  await page.getByRole("option", { name: /Lacta/ }).click();

  const value = await readFormValue(component);
  expect(value).toMatchObject({
    products: ["vtex:product:151331", "", "vtex:product:151332"],
  });
});
