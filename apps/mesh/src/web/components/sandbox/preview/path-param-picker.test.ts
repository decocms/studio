import { describe, expect, test } from "bun:test";
import {
  categoryOptionsFromPayload,
  detectPickerKind,
  filterPickerOptions,
  pickerLoaderRequest,
  productOptionsFromPayload,
  productSlugFromUrl,
} from "./path-param-picker";

describe("detectPickerKind", () => {
  test("param followed by /p at the end is a product", () => {
    expect(detectPickerKind("/:slug/p", "slug")).toBe("product");
    expect(detectPickerKind("/foo/:id/p", "id")).toBe("product");
  });

  test("trailing slash is normalized away", () => {
    expect(detectPickerKind("/:slug/p/", "slug")).toBe("product");
  });

  test("only the param right before /p gets the product picker", () => {
    expect(detectPickerKind("/:a/:b/p", "b")).toBe("product");
    expect(detectPickerKind("/:a/:b/p", "a")).toBeNull();
  });

  test("params not followed by a trailing /p get no picker", () => {
    expect(detectPickerKind("/blog/:slug", "slug")).toBeNull();
    expect(detectPickerKind("/:slug/p/x", "slug")).toBeNull();
  });

  test("catch-all is a category", () => {
    expect(detectPickerKind("/*", "*")).toBe("category");
    expect(detectPickerKind("/c/*", "*")).toBe("category");
  });

  test("catch-all name on a template without * gets no picker", () => {
    expect(detectPickerKind("/:slug/p", "*")).toBeNull();
  });
});

describe("pickerLoaderRequest", () => {
  test("product searches server-side with the term", () => {
    expect(pickerLoaderRequest("product", "tee")).toEqual({
      resolveType: "vtex/loaders/intelligentSearch/productList.ts",
      props: { query: "tee", count: 10 },
    });
  });

  test("category fetches the whole tree, term-independent", () => {
    expect(pickerLoaderRequest("category", "hats")).toEqual({
      resolveType: "vtex/loaders/categories/tree.ts",
      props: {},
    });
  });
});

describe("productSlugFromUrl", () => {
  test("extracts the segment before /p", () => {
    expect(productSlugFromUrl("https://store.com/apple-watch/p")).toBe(
      "apple-watch",
    );
    expect(productSlugFromUrl("/apple-watch/p")).toBe("apple-watch");
    expect(productSlugFromUrl("/apple-watch/p/")).toBe("apple-watch");
    expect(productSlugFromUrl("https://store.com/tv-4k/p?skuId=12")).toBe(
      "tv-4k",
    );
  });

  test("decodes percent-encoded slugs", () => {
    expect(productSlugFromUrl("/caf%C3%A9/p")).toBe("café");
  });

  test("rejects urls without the /p suffix or with extra segments", () => {
    expect(productSlugFromUrl("https://store.com/apple-watch")).toBeNull();
    expect(productSlugFromUrl("/a/b/p")).toBeNull();
    expect(productSlugFromUrl("/p")).toBeNull();
  });

  test("rejects non-string and unparseable values", () => {
    expect(productSlugFromUrl(undefined)).toBeNull();
    expect(productSlugFromUrl(42)).toBeNull();
    expect(productSlugFromUrl("")).toBeNull();
    expect(productSlugFromUrl("http://")).toBeNull();
  });
});

describe("productOptionsFromPayload", () => {
  test("maps products to options with label precedence and image", () => {
    const payload = [
      {
        url: "https://store.com/tv-4k/p",
        name: "TV 4K 55in",
        isVariantOf: { name: "TV 4K" },
        image: [{ url: "https://img.com/tv.jpg" }],
      },
      { url: "/mouse/p", name: "Mouse" },
      { url: "/keyboard/p" },
    ];
    expect(productOptionsFromPayload(payload)).toEqual([
      { value: "tv-4k", label: "TV 4K", image: "https://img.com/tv.jpg" },
      { value: "mouse", label: "Mouse", image: undefined },
      { value: "keyboard", label: "keyboard", image: undefined },
    ]);
  });

  test("skips items without an extractable slug and dedupes", () => {
    const payload = [
      { url: "/tv/p", name: "TV" },
      { url: "/tv/p", name: "TV duplicate" },
      { url: "/not-a-product", name: "Nope" },
      { name: "No url" },
      null,
      "garbage",
    ];
    expect(productOptionsFromPayload(payload)).toEqual([
      { value: "tv", label: "TV", image: undefined },
    ]);
  });

  test("non-string image entries are dropped", () => {
    const payload = [{ url: "/tv/p", name: "TV", image: [{ url: 42 }] }];
    expect(productOptionsFromPayload(payload)[0]?.image).toBeUndefined();
  });

  test("non-array payloads yield no options", () => {
    expect(productOptionsFromPayload(null)).toEqual([]);
    expect(productOptionsFromPayload({})).toEqual([]);
    expect(productOptionsFromPayload("x")).toEqual([]);
  });
});

describe("categoryOptionsFromPayload", () => {
  test("flattens the tree DFS with breadcrumb labels", () => {
    const payload = [
      {
        name: "Apparel",
        url: "https://store.com/apparel",
        children: [
          { name: "Hats", url: "https://store.com/apparel/hats" },
          { name: "Shoes", url: "https://store.com/apparel/shoes" },
        ],
      },
      { name: "Home", url: "https://store.com/home", children: null },
    ];
    expect(categoryOptionsFromPayload(payload)).toEqual([
      { value: "apparel", label: "Apparel" },
      { value: "apparel/hats", label: "Apparel › Hats" },
      { value: "apparel/shoes", label: "Apparel › Shoes" },
      { value: "home", label: "Home" },
    ]);
  });

  test("nodes without a url still recurse into children", () => {
    const payload = [
      {
        name: "Root",
        children: [{ name: "Leaf", url: "/root/leaf" }],
      },
    ];
    expect(categoryOptionsFromPayload(payload)).toEqual([
      { value: "root/leaf", label: "Root › Leaf" },
    ]);
  });

  test("tolerates malformed nodes and dedupes by value", () => {
    const payload = [
      null,
      "garbage",
      { name: "A", url: "/a", children: "not-an-array" },
      { name: "A again", url: "/a/" },
    ];
    expect(categoryOptionsFromPayload(payload)).toEqual([
      { value: "a", label: "A" },
    ]);
  });

  test("non-array payloads yield no options", () => {
    expect(categoryOptionsFromPayload(null)).toEqual([]);
    expect(categoryOptionsFromPayload({})).toEqual([]);
  });
});

describe("filterPickerOptions", () => {
  const hats = { value: "apparel/hats", label: "Apparel › Hats" };
  const shoes = { value: "apparel/shoes", label: "Apparel › Shoes" };
  const electronics = { value: "electronics", label: "Electronics" };
  const options = [hats, shoes, electronics];

  test("matches case-insensitively on label and value", () => {
    expect(filterPickerOptions(options, "HATS")).toEqual([hats]);
    expect(filterPickerOptions(options, "apparel/")).toEqual([hats, shoes]);
  });

  test("empty term returns the first max options", () => {
    expect(filterPickerOptions(options, "")).toEqual(options);
    expect(filterPickerOptions(options, "", 2)).toEqual([hats, shoes]);
  });

  test("cap applies to matches too", () => {
    expect(filterPickerOptions(options, "apparel", 1)).toEqual([hats]);
  });
});
