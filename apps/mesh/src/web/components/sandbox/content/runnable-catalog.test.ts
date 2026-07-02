import { describe, expect, it } from "bun:test";
import type { LiveMeta } from "@/web/components/sections-editor/resolve-schema";
import {
  groupRunnables,
  isManifestRunnableResolveType,
  listAvailableRunnables,
  listSavedRunnables,
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
  });

  it("runnableGroupKey groups by vendor / deco engine", () => {
    expect(runnableGroupKey("vtex/loaders/legacy/productList.ts")).toBe("vtex");
    expect(runnableGroupKey("$live/loaders/state.ts")).toBe("deco");
    expect(runnableGroupKey("deco/loaders/x.ts")).toBe("deco");
    expect(runnableGroupKey("deco-sites/mysite/loaders/x.ts")).toBe("mysite");
    expect(runnableGroupKey("site/loaders/products.ts")).toBe("site");
  });

  it("groupRunnables buckets entries by namespace, sorted", () => {
    const groups = groupRunnables(listAvailableRunnables(meta, "loaders"));
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
    expect(byKey.vtex?.entries.map((e) => e.resolveType)).toEqual([
      "vtex/loaders/legacy/productList.ts",
    ]);
    expect(byKey.deco?.title).toBe("Deco");
    expect(byKey.deco?.entries.map((e) => e.resolveType)).toEqual([
      "$live/loaders/state.ts",
    ]);
    // Groups sorted by title.
    expect(groups.map((g) => g.title)).toEqual(
      [...groups.map((g) => g.title)].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("listAvailableRunnables scopes actions to the actions block type", () => {
    const actions = listAvailableRunnables(meta, "actions");
    expect(actions.map((a) => a.resolveType)).toEqual([
      "site/actions/submit.ts",
    ]);
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
});
