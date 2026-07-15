import { describe, expect, test } from "bun:test";
import {
  categoryOptionsFromPayload,
  classifyParamKinds,
  collectPageLoaderResolveTypes,
  commercePlatformsFromLoaders,
  filterPickerOptions,
  mergePickerOptions,
  productOptionsFromPayload,
  resolveOptionSources,
  valueFromEntityUrl,
  type PathParamKind,
} from "./path-param-picker";

const VTEX_PRODUCT = "vtex/loaders/intelligentSearch/productList.ts";
const VTEX_TREE = "vtex/loaders/categories/tree.ts";
const ALGOLIA_LIST = "site/loaders/algolia/products/list.ts";
const MAGENTO_PDP = "magento/loaders/product/detailsPageGQL.ts";
const MAGENTO_PLP = "magento/loaders/product/listingPage.ts";

const kinds = (...k: PathParamKind[]) => new Set<PathParamKind>(k);
const pdpCtx = { template: "/:slug/p", paramName: "slug" };

describe("classifyParamKinds", () => {
  test("VTEX URL shapes classify without page loaders", () => {
    expect([...classifyParamKinds("/:slug/p", "slug", new Set())]).toEqual([
      "product",
    ]);
    expect([...classifyParamKinds("/foo/:id/p", "id", new Set())]).toEqual([
      "product",
    ]);
    expect([...classifyParamKinds("/*", "*", new Set())]).toEqual(["category"]);
    expect([...classifyParamKinds("/c/*", "*", new Set())]).toEqual([
      "category",
    ]);
  });

  test("only the param right before /p is a product", () => {
    expect([...classifyParamKinds("/:a/:b/p", "b", new Set())]).toEqual([
      "product",
    ]);
    expect([...classifyParamKinds("/:a/:b/p", "a", new Set())]).toEqual([]);
  });

  test("loader-based: a detailsPage loader classifies product (no /p needed)", () => {
    // Magento PDP: /granado/:slug with a detailsPageGQL loader, no trailing /p.
    expect([
      ...classifyParamKinds("/:slug", "slug", new Set([MAGENTO_PDP])),
    ]).toEqual(["product"]);
    expect([
      ...classifyParamKinds(
        "/:slug",
        "slug",
        new Set(["vtex/loaders/productDetailsPage.ts"]),
      ),
    ]).toEqual(["product"]);
  });

  test("loader-based: a listingPage loader classifies category", () => {
    expect([
      ...classifyParamKinds("/produtos/:slug", "slug", new Set([MAGENTO_PLP])),
    ]).toEqual(["category"]);
  });

  test("a catch-all wiring both detail and listing loaders is both", () => {
    // Granado's `$` route resolves PDP or PLP at runtime → both.
    expect(
      classifyParamKinds("/*", "*", new Set([MAGENTO_PDP, MAGENTO_PLP])),
    ).toEqual(kinds("product", "category"));
  });

  test("classifies by loader/block name (PDP → product, PLP → category)", () => {
    expect(
      classifyParamKinds("/*", "*", new Set(["PDP Magento loader (GQL)"])),
    ).toEqual(kinds("product", "category")); // + category from the `*` shape
    expect([
      ...classifyParamKinds("/:slug", "slug", new Set(["PDP Custom Loader"])),
    ]).toEqual(["product"]);
    expect([
      ...classifyParamKinds("/:slug", "slug", new Set(["PLP Custom Loader"])),
    ]).toEqual(["category"]);
  });

  test("params with no loader and no shape get nothing", () => {
    expect([...classifyParamKinds("/blog/:slug", "slug", new Set())]).toEqual(
      [],
    );
  });
});

describe("resolveOptionSources", () => {
  test("binds the VTEX product loader present in the manifest", () => {
    const [source] = resolveOptionSources(
      kinds("product"),
      new Set([VTEX_PRODUCT]),
    );
    expect(source?.kind).toBe("product");
    expect(source?.resolveType).toBe(VTEX_PRODUCT);
    expect(source?.clientFilter).toBe(false);
  });

  test("VTEX product requests: numeric term also tries ids, ids first", () => {
    const [source] = resolveOptionSources(
      kinds("product"),
      new Set([VTEX_PRODUCT]),
    );
    expect(source?.buildRequests("123")).toEqual([
      { resolveType: VTEX_PRODUCT, props: { ids: ["123"] } },
      { resolveType: VTEX_PRODUCT, props: { query: "123", count: 10 } },
    ]);
    expect(source?.buildRequests("torrada-multigraos")).toEqual([
      {
        resolveType: VTEX_PRODUCT,
        props: { query: "torrada multigraos", count: 10 },
      },
    ]);
  });

  test("falls back to the site's Algolia search loader when no VTEX loader", () => {
    const [source] = resolveOptionSources(
      kinds("product"),
      new Set([ALGOLIA_LIST]),
    );
    expect(source?.resolveType).toBe(ALGOLIA_LIST);
    expect(source?.buildRequests("torrada")).toEqual([
      {
        resolveType: ALGOLIA_LIST,
        props: { term: "torrada", hitsPerPage: 10 },
      },
    ]);
  });

  test("candidate order is priority: VTEX wins over Algolia", () => {
    const [source] = resolveOptionSources(
      kinds("product"),
      new Set([ALGOLIA_LIST, VTEX_PRODUCT]),
    );
    expect(source?.resolveType).toBe(VTEX_PRODUCT);
  });

  test("category binds a tree loader as a client-filtered source", () => {
    const [source] = resolveOptionSources(
      kinds("category"),
      new Set([VTEX_TREE]),
    );
    expect(source?.kind).toBe("category");
    expect(source?.clientFilter).toBe(true);
    expect(source?.buildRequests("anything")).toEqual([
      { resolveType: VTEX_TREE, props: {} },
    ]);
  });

  test("prefers the page platform's own search loader over a neutral index", () => {
    // Magento page with both its native product search AND Algolia present:
    // Magento's public GraphQL search wins (no external index dependency).
    const magentoList = "magento/loaders/product/list.ts";
    const [product] = resolveOptionSources(
      kinds("product"),
      new Set([ALGOLIA_LIST, magentoList]),
      new Set(["magento"]),
    );
    expect(product?.resolveType).toBe(magentoList);
    expect(product?.buildRequests("sabonete")).toEqual([
      {
        resolveType: magentoList,
        props: { props: { search: "sabonete", pageSize: 10, currentPage: 1 } },
      },
    ]);
  });

  test("skips a competing vendor's loader for the page's platform", () => {
    // Magento store that also has the VTEX app installed: product must resolve
    // to the neutral Algolia loader, NOT vtex; category must NOT invoke a vtex
    // category-tree loader that merely exists in the manifest.
    const magento = new Set(["magento"]);
    const [product] = resolveOptionSources(
      kinds("product"),
      new Set([VTEX_PRODUCT, ALGOLIA_LIST]),
      magento,
    );
    expect(product?.resolveType).toBe(ALGOLIA_LIST);
    expect(
      resolveOptionSources(
        kinds("category"),
        new Set(["vtex/loaders/catalog/getCategoryTree"]),
        magento,
      ),
    ).toEqual([]);
  });

  test("commercePlatformsFromLoaders picks vendor namespaces only", () => {
    expect(
      commercePlatformsFromLoaders([
        MAGENTO_PDP,
        ALGOLIA_LIST,
        "PDP Magento loader (GQL)",
        "site/loaders/features.ts",
      ]),
    ).toEqual(new Set(["magento"]));
  });

  test("a kind with no available loader yields no source", () => {
    // Granado: product (Algolia) resolves, category has no tree loader.
    const sources = resolveOptionSources(
      kinds("product", "category"),
      new Set([ALGOLIA_LIST]),
    );
    expect(sources.map((s) => s.kind)).toEqual(["product"]);
    expect(resolveOptionSources(kinds("product"), new Set())).toEqual([]);
  });
});

describe("valueFromEntityUrl", () => {
  test("VTEX /p shape strips the trailing /p", () => {
    expect(
      valueFromEntityUrl("https://store.com/apple-watch/p", "/:slug/p", "slug"),
    ).toBe("apple-watch");
    expect(valueFromEntityUrl("/apple-watch/p", "/:slug/p", "slug")).toBe(
      "apple-watch",
    );
    expect(valueFromEntityUrl("/apple-watch/p/", "/:slug/p", "slug")).toBe(
      "apple-watch",
    );
    expect(
      valueFromEntityUrl(
        "https://store.com/tv-4k/p?skuId=12",
        "/:slug/p",
        "slug",
      ),
    ).toBe("tv-4k");
  });

  test("Magento catch-all (no /p) keeps the whole path, multi-segment ok", () => {
    expect(valueFromEntityUrl("/eau-de-toilette-spritz-100ml", "/*", "*")).toBe(
      "eau-de-toilette-spritz-100ml",
    );
    expect(valueFromEntityUrl("/granado/campanhas/produtos", "/*", "*")).toBe(
      "granado/campanhas/produtos",
    );
  });

  test("static prefix in the template is stripped", () => {
    expect(
      valueFromEntityUrl("/granado/spritz-100ml", "/granado/:slug", "slug"),
    ).toBe("spritz-100ml");
  });

  test("decodes percent-encoded values", () => {
    expect(valueFromEntityUrl("/caf%C3%A9/p", "/:slug/p", "slug")).toBe("café");
  });

  test("rejects non-string, unparseable, and empty results", () => {
    expect(valueFromEntityUrl(undefined, "/:slug/p", "slug")).toBeNull();
    expect(valueFromEntityUrl(42, "/:slug/p", "slug")).toBeNull();
    expect(valueFromEntityUrl("", "/:slug/p", "slug")).toBeNull();
    expect(valueFromEntityUrl("/p", "/:slug/p", "slug")).toBeNull();
    expect(valueFromEntityUrl("/x/p", "/*", "missing")).toBeNull();
  });

  test("a leading dynamic param doesn't bleed into a later param's value", () => {
    expect(
      valueFromEntityUrl(
        "/electronics/apple-watch/p",
        "/:category/:slug/p",
        "slug",
      ),
    ).toBe("apple-watch");
    expect(
      valueFromEntityUrl(
        "/electronics/apple-watch/p",
        "/:category/:slug/p",
        "category",
      ),
    ).toBe("electronics");
  });
});

describe("productOptionsFromPayload", () => {
  test("maps a Product[] with label precedence and image", () => {
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
    expect(productOptionsFromPayload(payload, pdpCtx)).toEqual([
      { value: "tv-4k", label: "TV 4K", image: "https://img.com/tv.jpg" },
      { value: "mouse", label: "Mouse", image: undefined },
      { value: "keyboard", label: "keyboard", image: undefined },
    ]);
  });

  test("accepts a ProductListingPage ({ products })", () => {
    const payload = { products: [{ url: "/tv/p", name: "TV" }] };
    expect(productOptionsFromPayload(payload, pdpCtx)).toEqual([
      { value: "tv", label: "TV", image: undefined },
    ]);
  });

  test("accepts a ProductList ({ list }) — e.g. the Algolia loader", () => {
    const payload = {
      "@type": "ProductList",
      list: [{ url: "/tv/p", name: "TV" }],
    };
    expect(productOptionsFromPayload(payload, pdpCtx)).toEqual([
      { value: "tv", label: "TV", image: undefined },
    ]);
  });

  test("catch-all template derives the full-path value", () => {
    const payload = [{ url: "/eau-de-toilette-100ml", name: "Spritz" }];
    expect(
      productOptionsFromPayload(payload, { template: "/*", paramName: "*" }),
    ).toEqual([
      { value: "eau-de-toilette-100ml", label: "Spritz", image: undefined },
    ]);
  });

  test("skips items without an extractable value and dedupes", () => {
    const payload = [
      { url: "/tv/p", name: "TV" },
      { url: "/tv/p", name: "TV duplicate" },
      { url: "/p", name: "Nope" },
      { name: "No url" },
      null,
      "garbage",
    ];
    expect(productOptionsFromPayload(payload, pdpCtx)).toEqual([
      { value: "tv", label: "TV", image: undefined },
    ]);
  });

  test("non-array, non-listing payloads yield no options", () => {
    expect(productOptionsFromPayload(null, pdpCtx)).toEqual([]);
    expect(productOptionsFromPayload({}, pdpCtx)).toEqual([]);
    expect(productOptionsFromPayload("x", pdpCtx)).toEqual([]);
  });
});

describe("collectPageLoaderResolveTypes", () => {
  const isLoader = (rt: string) => rt.includes("/loaders/");

  test("collects nested inline loader resolveTypes, ignores sections and non-loaders", () => {
    const page = {
      __resolveType: "website/pages/Page.tsx",
      sections: [
        {
          __resolveType: "site/sections/ProductDetails.tsx",
          page: { __resolveType: MAGENTO_PDP, props: { slug: "x" } },
        },
        { __resolveType: "site/sections/Shelf.tsx" },
      ],
      loader: { __resolveType: MAGENTO_PLP },
    };
    expect(
      [...collectPageLoaderResolveTypes(page, {}, isLoader)].sort(),
    ).toEqual([MAGENTO_PDP, MAGENTO_PLP].sort());
  });

  test("follows __resolveType block references and keeps the block name", () => {
    // Granado wires loaders as saved blocks referenced by key, not inline.
    const decofile = {
      "PDP Magento loader (GQL)": { __resolveType: MAGENTO_PDP, foo: 1 },
      "PLP Magento loader": { __resolveType: MAGENTO_PLP },
      // A non-loader block with a PDP-ish name is NOT kept as a signal.
      "PDP Shelf": { __resolveType: "site/sections/Product/Shelf.tsx" },
    };
    const page = {
      __resolveType: "website/pages/Page.tsx",
      sections: [
        { page: { __resolveType: "PDP Magento loader (GQL)" } },
        { page: { __resolveType: "PLP Magento loader" } },
        { shelf: { __resolveType: "PDP Shelf" } },
      ],
    };
    expect(
      [...collectPageLoaderResolveTypes(page, decofile, isLoader)].sort(),
    ).toEqual(
      [
        MAGENTO_PDP,
        MAGENTO_PLP,
        "PDP Magento loader (GQL)",
        "PLP Magento loader",
      ].sort(),
    );
  });

  test("tolerates cycles and malformed input", () => {
    const decofile = { a: { __resolveType: "b" }, b: { __resolveType: "a" } };
    expect([
      ...collectPageLoaderResolveTypes(
        { __resolveType: "a" },
        decofile,
        isLoader,
      ),
    ]).toEqual([]);
    expect([...collectPageLoaderResolveTypes(null, {}, isLoader)]).toEqual([]);
    expect([...collectPageLoaderResolveTypes("x", {}, isLoader)]).toEqual([]);
    expect([
      ...collectPageLoaderResolveTypes([{ a: 1 }], {}, isLoader),
    ]).toEqual([]);
  });
});

describe("mergePickerOptions", () => {
  test("merges in order and drops later duplicates by value", () => {
    const byId = [{ value: "tv-4k", label: "TV 4K (by id)" }];
    const byQuery = [
      { value: "tv-4k", label: "TV 4K" },
      { value: "tv-8k", label: "TV 8K" },
    ];
    expect(mergePickerOptions([byId, byQuery])).toEqual([
      { value: "tv-4k", label: "TV 4K (by id)" },
      { value: "tv-8k", label: "TV 8K" },
    ]);
  });

  test("empty lists merge to empty", () => {
    expect(mergePickerOptions([])).toEqual([]);
    expect(mergePickerOptions([[], []])).toEqual([]);
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
      { name: "Root", children: [{ name: "Leaf", url: "/root/leaf" }] },
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
