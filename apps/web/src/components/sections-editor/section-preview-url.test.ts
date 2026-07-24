import { describe, expect, it } from "bun:test";
import {
  buildInstantPagePreviewUrl,
  INSTANT_PREVIEW_MAX_URL_LENGTH,
} from "./section-preview-url";

describe("buildInstantPagePreviewUrl", () => {
  const decofile = {
    "pages-home-abc": {
      __resolveType: "website/pages/Page.tsx",
      sections: [{ __resolveType: "site/sections/Hero.tsx" }],
    },
    "site/sections/Hero.tsx": { title: "Hi" },
  };

  it("targets /live/previews/<pageBlockKey> on the production origin", () => {
    const href = buildInstantPagePreviewUrl({
      baseUrl: "https://shop.example.com/some/path?ignored=1",
      pageBlockKey: "pages-home-abc",
      path: "/",
      decofile,
    });
    const url = new URL(href!);
    expect(url.origin).toBe("https://shop.example.com");
    // The block key is URL-encoded into the path segment.
    expect(url.pathname).toBe("/live/previews/pages-home-abc");
  });

  it("pushes the draft so the server can decode it back exactly", () => {
    const href = buildInstantPagePreviewUrl({
      baseUrl: "https://shop.example.com",
      pageBlockKey: "pages-home-abc",
      path: "/",
      decofile,
    });
    // Mirror the server: `JSON.parse(decodeURIComponent(searchParams.get(...)))`.
    const raw = new URL(href!).searchParams.get("__decofile");
    expect(JSON.parse(decodeURIComponent(raw!))).toEqual(decofile);
  });

  it("encodes a block key that contains a slash", () => {
    const href = buildInstantPagePreviewUrl({
      baseUrl: "https://shop.example.com",
      pageBlockKey: "site/pages/Landing.tsx",
      path: "/lp",
      decofile,
    });
    const url = new URL(href!);
    expect(url.pathname).toBe(
      `/live/previews/${encodeURIComponent("site/pages/Landing.tsx")}`,
    );
    expect(url.searchParams.get("path")).toBe("/lp");
    expect(url.searchParams.get("pathTemplate")).toBe("/lp");
  });

  it("returns null when the encoded URL exceeds the cap (fall back to published route)", () => {
    // A decofile large enough to blow past the default ceiling.
    const huge: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++)
      huge[`block-${i}`] = { title: `x`.repeat(20) };
    const href = buildInstantPagePreviewUrl({
      baseUrl: "https://shop.example.com",
      pageBlockKey: "pages-home-abc",
      path: "/",
      decofile: huge,
    });
    expect(href).toBeNull();
  });

  it("honors a custom maxUrlLength", () => {
    const href = buildInstantPagePreviewUrl({
      baseUrl: "https://shop.example.com",
      pageBlockKey: "pages-home-abc",
      path: "/",
      decofile,
      maxUrlLength: 1,
    });
    expect(href).toBeNull();
  });

  it("stays under the documented ceiling for a small decofile", () => {
    const href = buildInstantPagePreviewUrl({
      baseUrl: "https://shop.example.com",
      pageBlockKey: "pages-home-abc",
      path: "/",
      decofile,
    });
    expect(href!.length).toBeLessThanOrEqual(INSTANT_PREVIEW_MAX_URL_LENGTH);
  });
});
