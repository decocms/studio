import { describe, expect, it } from "bun:test";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import {
  isManifestRunnableResolveType,
  listAvailableRunnables,
  listSavedRunnables,
  readSavedRunnableBlock,
  runnableFolderPath,
  runnableGroupKey,
} from "./runnable-catalog";

const meta: LiveMeta = {
  manifest: {
    blocks: {
      sections: {
        "site/sections/Header/Header.tsx": { $ref: "#/definitions/Header" },
      },
      loaders: {
        "site/loaders/products.ts": { $ref: "#/definitions/Products" },
        "vtex/loaders/legacy/productList.ts": {
          $ref: "#/definitions/ProductList",
        },
        "site/loaders/Preview.ts": { $ref: "#/definitions/Preview" },
        "shopify/loaders/internal.ts": { $ref: "#/definitions/Internal" },
        "$live/loaders/state.ts": { $ref: "#/definitions/State" },
        "workflows/loaders/events.ts": { $ref: "#/definitions/Events" },
      },
      actions: {
        "site/actions/submit.ts": { $ref: "#/definitions/Submit" },
      },
    },
  },
  schema: {
    definitions: {
      // Marked hidden via the deco `ignore` convention — must be filtered out.
      Internal: { title: "Internal", ignore: true },
    },
  },
};

describe("runnable-catalog", () => {
  it("isManifestRunnableResolveType matches only the requested kind", () => {
    expect(
      isManifestRunnableResolveType(
        meta,
        "site/loaders/products.ts",
        "loaders",
      ),
    ).toBe(true);
    expect(
      isManifestRunnableResolveType(meta, "site/actions/submit.ts", "actions"),
    ).toBe(true);
    // A loader is not an action and vice versa.
    expect(
      isManifestRunnableResolveType(
        meta,
        "site/loaders/products.ts",
        "actions",
      ),
    ).toBe(false);
    // Sections are neither.
    expect(
      isManifestRunnableResolveType(
        meta,
        "site/sections/Header/Header.tsx",
        "loaders",
      ),
    ).toBe(false);
  });

  it("listAvailableRunnables skips previews and blocks marked hidden", () => {
    const loaders = listAvailableRunnables(meta, "loaders");
    const resolveTypes = loaders.map((l) => l.resolveType);
    expect(resolveTypes).toContain("site/loaders/products.ts");
    expect(resolveTypes).toContain("vtex/loaders/legacy/productList.ts");
    // Preview stub filtered by name.
    expect(resolveTypes).not.toContain("site/loaders/Preview.ts");
    // `ignore: true` in the schema filters the block out.
    expect(resolveTypes).not.toContain("shopify/loaders/internal.ts");
    // The workflows app's plumbing loaders are hidden entirely.
    expect(resolveTypes).not.toContain("workflows/loaders/events.ts");
  });

  it("runnableGroupKey groups by vendor / deco engine", () => {
    expect(runnableGroupKey("vtex/loaders/legacy/productList.ts")).toBe("vtex");
    expect(runnableGroupKey("$live/loaders/state.ts")).toBe("deco");
    expect(runnableGroupKey("deco/loaders/x.ts")).toBe("deco");
    expect(runnableGroupKey("deco-sites/mysite/loaders/x.ts")).toBe("mysite");
    expect(runnableGroupKey("site/loaders/products.ts")).toBe("site");
  });

  it("runnableFolderPath walks the resolveType as folders", () => {
    expect(
      runnableFolderPath("vtex/loaders/intelligentSearch/productList.ts"),
    ).toEqual(["vtex", "intelligentSearch"]);
    expect(runnableFolderPath("vtex/loaders/legacy/productList.ts")).toEqual([
      "vtex",
      "legacy",
    ]);
    expect(runnableFolderPath("site/loaders/products.ts")).toEqual(["site"]);
    expect(runnableFolderPath("$live/loaders/state.ts")).toEqual(["deco"]);
    expect(
      runnableFolderPath("deco-sites/mysite/loaders/product/detail.ts"),
    ).toEqual(["mysite", "product"]);
    expect(runnableFolderPath("site/actions/cart/add.ts")).toEqual([
      "site",
      "cart",
    ]);
  });

  it("listAvailableRunnables scopes actions to the actions block type", () => {
    const actions = listAvailableRunnables(meta, "actions");
    expect(actions.map((a) => a.resolveType)).toEqual([
      "site/actions/submit.ts",
    ]);
  });

  it("collapses tanstack bare/suffixed alias pairs onto the suffixed key", () => {
    // Tanstack manifests register `X` (invoke alias, __resolveType-only stub)
    // AND `X.ts` (real module, carries the generated props schema).
    const tanstackMeta: LiveMeta = {
      manifest: {
        blocks: {
          loaders: {
            "site/loaders/CheckStock": { $ref: "#/definitions/StubB64" },
            "site/loaders/CheckStock.ts": { $ref: "#/definitions/RealB64" },
            "site/loaders/List/Sections": { $ref: "#/definitions/StubB64" },
            "site/loaders/List/Sections.tsx": { $ref: "#/definitions/RealB64" },
            // Bare-only key (no suffixed twin) must stay listed.
            "vtex/actions/cart/updateItems": { $ref: "#/definitions/StubB64" },
          },
        },
      },
      schema: {
        definitions: {
          // Tanstack defs title themselves with their own key.
          StubB64: { title: "site/loaders/CheckStock" },
          RealB64: { title: "site/loaders/CheckStock.ts" },
        },
      },
    };

    const loaders = listAvailableRunnables(tanstackMeta, "loaders");
    expect(loaders.map((l) => l.resolveType).sort()).toEqual([
      "site/loaders/CheckStock.ts",
      "site/loaders/List/Sections.tsx",
      "vtex/actions/cart/updateItems",
    ]);
    // Self-referential def titles fall back to the resolveType label.
    expect(
      loaders.find((l) => l.resolveType === "site/loaders/CheckStock.ts")
        ?.title,
    ).toBe("CheckStock");
  });

  it("listSavedRunnables picks decofile blocks of the matching kind", () => {
    const decofile: Record<string, unknown> = {
      MyProducts: {
        __resolveType: "site/loaders/products.ts",
        name: "My products",
        count: 10,
      },
      MySubmit: { __resolveType: "site/actions/submit.ts" },
      // Not a runnable — should be ignored.
      Header: { __resolveType: "site/sections/Header/Header.tsx" },
      // Nested path keys and non-objects are skipped.
      "pages/home": { __resolveType: "site/loaders/products.ts" },
      plain: "value",
    };

    const savedLoaders = listSavedRunnables(meta, decofile, "loaders");
    expect(savedLoaders).toEqual([
      {
        key: "MyProducts",
        resolveType: "site/loaders/products.ts",
        title: "My products",
      },
    ]);

    const savedActions = listSavedRunnables(meta, decofile, "actions");
    expect(savedActions).toEqual([
      {
        key: "MySubmit",
        resolveType: "site/actions/submit.ts",
        title: "MySubmit",
      },
    ]);
  });

  it("listSavedRunnables skips auto-preview stubs and hidden workflow groups", () => {
    // The preview picker renders this list, so stubs/workflows must not leak in.
    const decofile: Record<string, unknown> = {
      MyProducts: { __resolveType: "site/loaders/products.ts" },
      "Preview Home": { __resolveType: "site/loaders/products.ts" },
      MyEvents: { __resolveType: "workflows/loaders/events.ts" },
    };

    expect(
      listSavedRunnables(meta, decofile, "loaders").map((l) => l.key),
    ).toEqual(["MyProducts"]);
  });

  it("readSavedRunnableBlock strips __resolveType, keeps props, falls back title to the key", () => {
    const decofile: Record<string, unknown> = {
      MyProducts: {
        __resolveType: "site/loaders/products.ts",
        name: "My products",
        count: 10,
      },
      Bare: { __resolveType: "site/loaders/products.ts" },
    };

    expect(readSavedRunnableBlock(decofile, "MyProducts")).toEqual({
      resolveType: "site/loaders/products.ts",
      props: { name: "My products", count: 10 },
      title: "My products",
    });
    // No `name` → title falls back to the block key.
    expect(readSavedRunnableBlock(decofile, "Bare").title).toBe("Bare");
    // Missing block → empty resolveType (callers show "no longer exists").
    expect(readSavedRunnableBlock(decofile, "Gone").resolveType).toBe("");
  });

  it("excludes redirect loaders — they have a dedicated Redirects collection", () => {
    // `website/loaders/redirect.ts` is a real manifest loader, so without the
    // guard it would double-list under Loaders alongside the Redirects tab.
    const redirectMeta: LiveMeta = {
      manifest: {
        blocks: {
          loaders: {
            "site/loaders/products.ts": { $ref: "#/definitions/Products" },
            "website/loaders/redirect.ts": { $ref: "#/definitions/Redirect" },
            "website/loaders/redirects.ts": { $ref: "#/definitions/Redirects" },
          },
        },
      },
      schema: {},
    };
    const decofile: Record<string, unknown> = {
      "redirects-old-abc": {
        __resolveType: "website/loaders/redirect.ts",
        redirect: { from: "/old", to: "/new", type: "permanent" },
      },
      MyProducts: { __resolveType: "site/loaders/products.ts" },
    };

    expect(
      listAvailableRunnables(redirectMeta, "loaders").map((l) => l.resolveType),
    ).toEqual(["site/loaders/products.ts"]);
    expect(
      listSavedRunnables(redirectMeta, decofile, "loaders").map((e) => e.key),
    ).toEqual(["MyProducts"]);
  });
});
