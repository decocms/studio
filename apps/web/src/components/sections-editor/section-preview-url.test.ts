import { describe, expect, it } from "bun:test";
import { buildFastPreviewDaemonUrl } from "./section-preview-url";

describe("buildFastPreviewDaemonUrl", () => {
  it("targets /_deco/fast-preview on the daemon (previewUrl) origin", () => {
    const href = buildFastPreviewDaemonUrl({
      previewUrl: "https://abc.deco.host/ignored?x=1",
      pageBlockKey: "pages-home-abc",
      path: "/",
      pathTemplate: "/",
      nonce: 0,
    });
    const url = new URL(href);
    expect(url.origin).toBe("https://abc.deco.host");
    expect(url.pathname).toBe("/_deco/fast-preview");
  });

  it("passes the page block key, path, and pathTemplate as query params", () => {
    const url = new URL(
      buildFastPreviewDaemonUrl({
        previewUrl: "https://abc.deco.host",
        pageBlockKey: "site/pages/Landing.tsx",
        path: "/lp/shoes",
        pathTemplate: "/lp/:slug",
        nonce: 3,
      }),
    );
    expect(url.searchParams.get("component")).toBe("site/pages/Landing.tsx");
    expect(url.searchParams.get("path")).toBe("/lp/shoes");
    expect(url.searchParams.get("pathTemplate")).toBe("/lp/:slug");
  });

  it("carries the nonce so a bump produces a distinct URL (forces reload)", () => {
    const base = {
      previewUrl: "https://abc.deco.host",
      pageBlockKey: "pages-home-abc",
      path: "/",
      pathTemplate: "/",
    };
    const a = buildFastPreviewDaemonUrl({ ...base, nonce: 1 });
    const b = buildFastPreviewDaemonUrl({ ...base, nonce: 2 });
    expect(new URL(a).searchParams.get("__cb")).toBe("1");
    expect(a).not.toBe(b);
  });

  it("does not embed the decofile (no URL-size cap)", () => {
    const href = buildFastPreviewDaemonUrl({
      previewUrl: "https://abc.deco.host",
      pageBlockKey: "pages-home-abc",
      path: "/",
      pathTemplate: "/",
      nonce: 0,
    });
    expect(href).not.toContain("__decofile");
    expect(href.length).toBeLessThan(200);
  });
});
