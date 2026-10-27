import { describe, expect, it } from "bun:test";
import {
  buildPageForcedVariants,
  buildSectionForcedVariants,
  buildServeDraftPointer,
  combineForcedVariants,
  withForcedVariants,
  withForcedVariantsInDraftUrl,
} from "./variant-draft-pointer";

const rule = { __resolveType: "website/matchers/always.ts" };
const plainPage = { multivariate: false, index: 0, variants: [] };
const mvPage = { multivariate: true, index: 1, variants: [{ rule }, { rule }] };
const mvObj = { variants: [{ rule }, { rule }, { rule }] };

describe("buildPageForcedVariants", () => {
  it("forces the page's sections multivariate to the active page variant", () => {
    expect(buildPageForcedVariants("Home", mvPage)).toEqual([
      "Home@sections=1",
    ]);
  });

  it("forces nothing on a page without variants", () => {
    expect(buildPageForcedVariants("Home", plainPage)).toEqual([]);
    expect(
      buildPageForcedVariants("Home", { ...mvPage, variants: [{ rule }] }),
    ).toEqual([]);
  });
});

describe("buildSectionForcedVariants", () => {
  const base = {
    pageKey: "Home",
    page: plainPage,
    sectionIndex: 3,
    sectionLazy: false,
    mvObj,
    selectedVariantIndex: 2,
  };

  it("addresses the section by its JSON path in the page", () => {
    expect(buildSectionForcedVariants(base)).toEqual(["Home@sections.3=2"]);
  });

  it("goes through the page variant and the Lazy wrapper", () => {
    expect(
      buildSectionForcedVariants({ ...base, page: mvPage, sectionLazy: true }),
    ).toEqual(["Home@sections.variants.1.value.3.section=2"]);
  });

  it("forces nothing for a variant that doesn't exist", () => {
    expect(
      buildSectionForcedVariants({ ...base, selectedVariantIndex: 3 }),
    ).toEqual([]);
    expect(buildSectionForcedVariants({ ...base, sectionIndex: -1 })).toEqual(
      [],
    );
  });
});

describe("combineForcedVariants", () => {
  // The site's forceVariants (@decocms/blocks src/v8/variants.ts) applies each
  // `<block>@<path>=<index>` in turn and leaves only the forced variant in the
  // addressed multivariate; an address that no longer resolves is ignored.
  function applyForced(block: unknown, forced: string[]): unknown {
    let root = structuredClone(block);
    for (const entry of forced) {
      const [, path = "", index] = entry.match(/^[^@]*@(.*)=(\d+)$/) ?? [];
      const keys = path === "" ? [] : path.split(".");
      let parent: Record<string, unknown> | null = null;
      let node: unknown = root;
      let last = "";
      for (const key of keys) {
        if (node === null || typeof node !== "object" || !(key in node)) {
          node = undefined;
          break;
        }
        parent = node as Record<string, unknown>;
        last = key;
        node = parent[key];
      }
      const variants = (node as { variants?: unknown[] } | undefined)?.variants;
      const picked = variants?.[Number(index)] as object | undefined;
      if (!picked) continue;
      const forcedNode = {
        ...(node as object),
        variants: [{ ...picked, rule: true }],
      };
      if (parent) parent[last] = forcedNode;
      else root = forcedNode;
    }
    return root;
  }
  type ForcedMv = { variants: unknown[] };
  type Forced = {
    sections: { variants: Array<{ value: { value: unknown[] } }> };
  };
  const lazy = (value: unknown) => ({ __resolveType: "lazy", value });
  const intro = (text: string) => ({ __resolveType: "intro", text });
  const sectionMv = {
    __resolveType: "multivariate",
    variants: [
      { rule, value: lazy(intro("mobile")) },
      { rule, value: lazy(intro("default")) },
    ],
  };
  const home = {
    sections: {
      __resolveType: "multivariate",
      variants: [
        { rule, value: lazy([intro("page 1")]) },
        { rule, value: lazy([intro("hero"), sectionMv]) },
      ],
    },
  };

  it("puts the section inside a page variant before the page, so the site applies both", () => {
    const page = buildPageForcedVariants("Home", {
      multivariate: true,
      index: 1,
      lazyValues: true,
      variants: [{ rule }, { rule }],
    });
    const section = buildSectionForcedVariants({
      pageKey: "Home",
      page: {
        multivariate: true,
        index: 1,
        lazyValues: true,
        variants: [{ rule }, { rule }],
      },
      sectionIndex: 1,
      sectionLazy: false,
      mvObj: sectionMv,
      selectedVariantIndex: 0,
    });
    const forced = combineForcedVariants(page, section);
    expect(forced).toEqual([
      "Home@sections.variants.1.value.value.1=0",
      "Home@sections=1",
    ]);
    const out = applyForced(home, forced) as Forced;
    expect(out.sections.variants).toHaveLength(1);
    const mv = out.sections.variants[0]?.value.value[1] as ForcedMv;
    expect(mv.variants).toEqual([{ rule: true, value: lazy(intro("mobile")) }]);
    // The page first would drop the section's address: what the preview did before.
    const wrong = applyForced(home, [...page, ...section]) as Forced;
    const kept = wrong.sections.variants[0]?.value.value[1] as ForcedMv;
    expect(kept.variants).toHaveLength(2);
  });
});

describe("withForcedVariants", () => {
  const pointer = "api.example/api/acme/decofile/vm/main?token=t.k-1@abc123";

  it("adds each as an encoded __variant parameter before the version", () => {
    expect(
      withForcedVariants(pointer, ["Home (2)@sections.3=1", "Header@=0"]),
    ).toBe(
      "api.example/api/acme/decofile/vm/main?token=t.k-1" +
        "&__variant=Home%20%282%29%40sections.3%3D1&__variant=Header%40%3D0@abc123",
    );
  });

  it("replaces the ones it already carried, and drops the query when none are left", () => {
    const forced = withForcedVariants("localhost:4547/@local", ["A@b=1"]);
    expect(forced).toBe("localhost:4547/?__variant=A%40b%3D1@local");
    expect(withForcedVariants(forced, ["A@b=2"])).toBe(
      "localhost:4547/?__variant=A%40b%3D2@local",
    );
    expect(withForcedVariants(forced, [])).toBe("localhost:4547/@local");
  });
});

describe("buildServeDraftPointer", () => {
  it("points at the deco serve endpoint, without the token", () => {
    expect(
      buildServeDraftPointer("http://127.0.0.1:4547/", ["Home@sections=1"]),
    ).toBe("127.0.0.1:4547/?__variant=Home%40sections%3D1@local");
    expect(buildServeDraftPointer("http://[::1]:4547/rpc", ["A@=0"])).toBe(
      "localhost:4547/rpc?__variant=A%40%3D0@local",
    );
  });

  it("is null with nothing forced", () => {
    expect(buildServeDraftPointer("http://localhost:4547/", [])).toBeNull();
  });
});

describe("withForcedVariantsInDraftUrl", () => {
  it("rewrites the URL's draft pointer", () => {
    const url = new URL(
      withForcedVariantsInDraftUrl(
        "https://site.example/p?__draft=api.example%2Fd%3Ftoken%3Dt%40v1&x=1",
        ["Home@sections=1"],
      ),
    );
    expect(url.searchParams.get("__draft")).toBe(
      "api.example/d?token=t&__variant=Home%40sections%3D1@v1",
    );
    expect(url.searchParams.get("x")).toBe("1");
  });

  it("leaves a URL without a pointer, or asking for the published render", () => {
    for (const href of [
      "https://site.example/p",
      "https://site.example/p?__draft=off",
    ]) {
      expect(withForcedVariantsInDraftUrl(href, ["A@=1"])).toBe(href);
    }
  });
});
