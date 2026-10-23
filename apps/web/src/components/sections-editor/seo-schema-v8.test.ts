import { describe, expect, test } from "bun:test";
import { createEmptyPageBlock } from "./page-block-template";
import type { LiveMeta } from "./resolve-schema";
import {
  findLivePageResolveType,
  findNewPageResolveType,
  listAvailableSections,
} from "./section-catalog";
import { findSiteSeoEntry, resolveSeoTarget } from "./seo-block";
import {
  defaultPageSeoResolveType,
  isSeoSectionResolveType,
  listPageSeoTypeOptions,
} from "./seo-schema";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const ref = (name: string) => ({ $ref: `#/definitions/${b64(name)}` });

function flat(name: string, properties: Record<string, unknown> = {}) {
  return {
    title: name,
    type: "object",
    required: ["__resolveType"],
    properties: {
      __resolveType: { type: "string", enum: [name], default: name },
      ...properties,
    },
  };
}

/**
 * The shape `deco schema` (next-major Blocks) writes: short block keys, the
 * built-in `page` whose `seo` field lists the blocks returning a `Seo`, and
 * the v7 page name as an alias with a copy of the same definition.
 */
function v8Meta({
  seoTypes = ["seo"],
}: {
  seoTypes?: string[];
} = {}): LiveMeta {
  const page = flat("page", {
    name: { type: "string", title: "Name" },
    path: { type: "string", title: "Path" },
    seo: {
      title: "SEO",
      anyOf: [{ $ref: "#/definitions/Resolvable" }, ...seoTypes.map(ref)],
      nullable: true,
    },
    sections: { type: "array", items: { $ref: "#/root/sections" } },
  });
  const alias = structuredClone(page);
  alias.title = "website/pages/Page.tsx";
  alias.properties.__resolveType = {
    type: "string",
    enum: ["website/pages/Page.tsx"],
    default: "website/pages/Page.tsx",
  };
  const definitions: Record<string, unknown> = {
    Resolvable: { title: "Resolvable" },
    [b64("page")]: page,
    [b64("website/pages/Page.tsx")]: alias,
    [b64("hero")]: flat("hero", { title: { type: "string" } }),
    [b64("theme")]: flat("theme", { primary: { type: "string" } }),
  };
  for (const t of seoTypes) {
    definitions[b64(t)] = flat(t, {
      title: { type: "string" },
      description: { type: "string" },
    });
  }
  return {
    blocksMajor: 8,
    manifest: {
      blocks: {
        // The alias comes first, as a lookup by insertion order would see it.
        pages: {
          "website/pages/Page.tsx": {
            ...ref("website/pages/Page.tsx"),
            namespace: "website",
          },
          page: { ...ref("page"), namespace: "deco" },
        },
        sections: Object.fromEntries(
          ["hero", "theme", ...seoTypes].map((k) => [k, ref(k)]),
        ),
        matchers: { always: ref("always"), never: ref("never") },
      },
    },
    schema: {
      definitions,
      root: { sections: { anyOf: [ref("hero"), ref("theme")] } },
    },
  } as LiveMeta;
}

describe("next-major page and SEO types", () => {
  test("a new page uses the built-in page, not the v7 alias", () => {
    const meta = v8Meta();
    expect(findLivePageResolveType(meta)).toBe("website/pages/Page.tsx");
    expect(findNewPageResolveType(meta)).toBe("page");
  });

  test("SEO options are the page schema's seo union, by short name", () => {
    const meta = v8Meta({ seoTypes: ["seo", "productSeo"] });
    expect(listPageSeoTypeOptions(meta).map((o) => o.resolveType)).toEqual([
      "seo",
      "productSeo",
    ]);
    expect(defaultPageSeoResolveType(meta)).toBe("seo");
    expect(isSeoSectionResolveType("productSeo", meta)).toBe(true);
    expect(isSeoSectionResolveType("hero", meta)).toBe(false);
    // Without the schema only the v7 file names are known.
    expect(isSeoSectionResolveType("seo")).toBe(false);
  });

  test("createEmptyPageBlock types the page and its SEO from the schema", () => {
    expect(createEmptyPageBlock("About", "/about", v8Meta())).toEqual({
      name: "About",
      path: "/about",
      sections: [],
      seo: { __resolveType: "seo" },
      __resolveType: "page",
    });
  });

  test("createEmptyPageBlock omits seo when the page schema offers none", () => {
    const meta = v8Meta({ seoTypes: [] });
    expect(listPageSeoTypeOptions(meta)).toEqual([]);
    expect(defaultPageSeoResolveType(meta)).toBe("");
    expect(createEmptyPageBlock("About", "/about", meta)).toEqual({
      name: "About",
      path: "/about",
      sections: [],
      __resolveType: "page",
    });
  });

  test("page SEO resolves to the schema's type; a page is never the site SEO", () => {
    const meta = v8Meta();
    const decofile = {
      "pages-home": {
        __resolveType: "page",
        name: "Home",
        path: "/",
        sections: [],
        seo: { __resolveType: "seo", title: "Home" },
      },
    };
    expect(findSiteSeoEntry(decofile, meta)).toBeNull();
    const resolved = resolveSeoTarget(
      decofile,
      { kind: "page", pageKey: "pages-home", pageName: "Home", path: "/" },
      meta,
    );
    expect(resolved?.seoResolveType).toBe("seo");
    expect(resolved?.seoTypeOptions?.map((o) => o.resolveType)).toEqual([
      "seo",
    ]);
  });

  test("a standalone block of an SEO type is found by the schema", () => {
    const meta = v8Meta();
    const entry = findSiteSeoEntry(
      { "Default SEO": { __resolveType: "seo", title: "Store" } },
      meta,
    );
    expect(entry?.kind).toBe("block");
    expect(entry?.seoResolveType).toBe("seo");
  });

  test("the theme block stays out of the section picker", () => {
    expect(
      listAvailableSections(v8Meta()).map((s) => s.resolveType),
    ).not.toContain("theme");
  });
});
