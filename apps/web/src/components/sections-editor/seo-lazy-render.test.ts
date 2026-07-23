import { describe, expect, test } from "bun:test";
import { DEFAULT_SEO_RESOLVE_TYPE } from "./seo-block";
import {
  defaultEnabledSeo,
  isSeoEnabled,
  isSeoLazyRender,
  LAZY_RENDER_RESOLVE_TYPE,
  toggleSeoAsyncRender,
  unwrapSeoConfig,
  wrapSeoPersistValue,
} from "./seo-lazy-render";

describe("unwrapSeoConfig", () => {
  test("returns null/undefined for disabled seo", () => {
    expect(unwrapSeoConfig(null)).toBeNull();
    expect(unwrapSeoConfig(undefined)).toBeUndefined();
  });

  test("unwraps lazy wrapper", () => {
    const inner = {
      __resolveType: "website/sections/Seo/SeoV2.tsx",
      title: "A",
    };
    const raw = {
      __resolveType: LAZY_RENDER_RESOLVE_TYPE,
      section: inner,
    };
    expect(isSeoLazyRender(raw)).toBe(true);
    expect(unwrapSeoConfig(raw)).toEqual(inner);
  });

  test("passes through direct seo config", () => {
    const seo = { __resolveType: DEFAULT_SEO_RESOLVE_TYPE, title: "Home" };
    expect(unwrapSeoConfig(seo)).toEqual(seo);
  });
});

describe("wrapSeoPersistValue", () => {
  test("preserves lazy wrapper on save", () => {
    const raw = {
      __resolveType: LAZY_RENDER_RESOLVE_TYPE,
      section: { __resolveType: DEFAULT_SEO_RESOLVE_TYPE },
    };
    const next = wrapSeoPersistValue(
      { __resolveType: DEFAULT_SEO_RESOLVE_TYPE, title: "New" },
      raw,
    );
    expect(next).toEqual({
      __resolveType: LAZY_RENDER_RESOLVE_TYPE,
      section: { __resolveType: DEFAULT_SEO_RESOLVE_TYPE, title: "New" },
    });
  });
});

describe("toggleSeoAsyncRender", () => {
  test("wraps direct seo in lazy render", () => {
    const seo = { __resolveType: DEFAULT_SEO_RESOLVE_TYPE };
    const wrapped = toggleSeoAsyncRender(true, seo);
    expect(wrapped).toEqual({
      __resolveType: LAZY_RENDER_RESOLVE_TYPE,
      section: seo,
    });
  });

  test("unwraps lazy render", () => {
    const inner = { __resolveType: DEFAULT_SEO_RESOLVE_TYPE, title: "X" };
    const wrapped = toggleSeoAsyncRender(false, {
      __resolveType: LAZY_RENDER_RESOLVE_TYPE,
      section: inner,
    });
    expect(wrapped).toEqual(inner);
  });
});

describe("defaultEnabledSeo", () => {
  test("creates minimal enabled seo", () => {
    expect(defaultEnabledSeo(DEFAULT_SEO_RESOLVE_TYPE)).toEqual({
      __resolveType: DEFAULT_SEO_RESOLVE_TYPE,
    });
    expect(isSeoEnabled(defaultEnabledSeo(DEFAULT_SEO_RESOLVE_TYPE))).toBe(
      true,
    );
  });
});
