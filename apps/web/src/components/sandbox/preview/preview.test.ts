import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { describe, expect, it } from "bun:test";
import {
  resolveInPlaceDraftUrl,
  resolvePreviewUrl,
  shouldInPlaceRender,
  withDecoFBT,
  withDeviceHint,
} from "./preview";

describe("withDeviceHint", () => {
  it("sets deviceHint on a well-formed URL", () => {
    expect(withDeviceHint("https://example.com/foo", "mobile")).toBe(
      "https://example.com/foo?deviceHint=mobile",
    );
  });

  it("falls back to the original string instead of throwing on a malformed URL", () => {
    expect(withDeviceHint("http://[::1", "mobile")).toBe("http://[::1");
  });
});

describe("withDecoFBT", () => {
  it("passes null through", () => {
    expect(withDecoFBT(null)).toBe(null);
  });

  it("sets __decoFBT=0 and __deco_ssr=1 on a well-formed URL", () => {
    expect(withDecoFBT("https://example.com/foo")).toBe(
      "https://example.com/foo?__decoFBT=0&__deco_ssr=1",
    );
  });

  it("falls back to the original string instead of throwing on a malformed URL", () => {
    expect(withDecoFBT("http://[::1")).toBe("http://[::1");
  });
});

describe("resolvePreviewUrl", () => {
  it("resolves path against base", () => {
    expect(resolvePreviewUrl("/foo", "https://example.com")).toBe(
      "https://example.com/foo",
    );
  });

  it("returns null instead of throwing when base is malformed", () => {
    expect(resolvePreviewUrl("/foo", "http://[::1")).toBe(null);
  });
});

describe("resolveInPlaceDraftUrl", () => {
  const homeA = "https://site.com/?__draft=ptr@sha1";
  const homeB = "https://site.com/?__draft=ptr@sha2";
  const pageP = "https://site.com/produto?__draft=ptr@sha2";

  it("tracks the live draft when not editing in place", () => {
    const r = resolveInPlaceDraftUrl(null, {
      inPlaceRenderActive: false,
      draftPreviewUrl: homeA,
      resolvedPath: "/",
    });
    expect(r.effective).toBe(homeA);
    expect(r.pin).toEqual({ path: "/", url: homeA });
  });

  it("latches the first draft URL once editing in place", () => {
    // Panel opened before the grant loaded: prior render pinned null.
    const r = resolveInPlaceDraftUrl(null, {
      inPlaceRenderActive: true,
      draftPreviewUrl: homeA,
      resolvedPath: "/",
    });
    expect(r.effective).toBe(homeA);
    expect(r.pin).toEqual({ path: "/", url: homeA });
  });

  it("freezes the URL against a version bump on the same path", () => {
    const prev = { path: "/", url: homeA };
    const r = resolveInPlaceDraftUrl(prev, {
      inPlaceRenderActive: true,
      draftPreviewUrl: homeB, // autosave bumped @sha1 -> @sha2
      resolvedPath: "/",
    });
    expect(r.effective).toBe(homeA); // still frozen, no reload
    expect(r.pin).toBe(prev);
  });

  it("re-latches on a page switch so the frame navigates", () => {
    const prev = { path: "/", url: homeA };
    const r = resolveInPlaceDraftUrl(prev, {
      inPlaceRenderActive: true,
      draftPreviewUrl: pageP,
      resolvedPath: "/produto",
    });
    expect(r.effective).toBe(pageP); // navigates to the new page
    expect(r.pin).toEqual({ path: "/produto", url: pageP });
  });

  it("stays null while editing in place with no grant yet", () => {
    const r = resolveInPlaceDraftUrl(null, {
      inPlaceRenderActive: true,
      draftPreviewUrl: null,
      resolvedPath: "/",
    });
    expect(r.effective).toBe(null);
    expect(r.pin).toBe(null);
  });
});

describe("shouldInPlaceRender", () => {
  const nav = (p: string) => JSON.stringify({ page: "pg", path: p });

  it("never renders on the first observation (baseline)", () => {
    expect(shouldInPlaceRender(null, { nav: nav("/"), content: "c1" })).toBe(
      false,
    );
  });

  it("does not render on a page/path switch (navigation shows it)", () => {
    expect(
      shouldInPlaceRender(
        { nav: nav("/"), content: "c1" },
        { nav: nav("/produto"), content: "c1" },
      ),
    ).toBe(false);
  });

  it("renders on a content edit on the same page", () => {
    expect(
      shouldInPlaceRender(
        { nav: nav("/"), content: "c1" },
        { nav: nav("/"), content: "c2" },
      ),
    ).toBe(true);
  });

  it("does not render when nothing changed", () => {
    expect(
      shouldInPlaceRender(
        { nav: nav("/"), content: "c1" },
        { nav: nav("/"), content: "c1" },
      ),
    ).toBe(false);
  });

  it("does not render when both page and content change (switch wins)", () => {
    expect(
      shouldInPlaceRender(
        { nav: nav("/"), content: "c1" },
        { nav: nav("/produto"), content: "c2" },
      ),
    ).toBe(false);
  });
});
